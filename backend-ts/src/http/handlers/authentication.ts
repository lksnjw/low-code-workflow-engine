import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";

import { hashPassword, verifyPassword } from "../../authn/password.js";
import { fail, loginRequestSchema, ok, registerRequestSchema } from "../../models/schemas.js";
import type { User } from "../../repository/store.js";
import type { ApplicationServices } from "../application-services.js";
import { INVALID_JSON_BODY } from "../request-body.js";

export type AuthenticatedUser = User & { role: string; permissions: string[] };
export type AuthenticationServices = Pick<ApplicationServices, "config" | "repository">;

export async function login(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthenticationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const parsed = loginRequestSchema.safeParse(request.body);
  if (!parsed.success)
    return reply.status(400).send(fail("Email and password are required", null));
  const email = parsed.data.email.trim().toLowerCase();
  const state = await services.repository.snapshot();
  const user = Object.values(state.users).find((item) => item.email.toLowerCase() === email);
  const hash = user === undefined
    ? "$2b$10$C6UzMDM.H6dfI/f/IKcEe.3n4Qj06DNMo2n7ixfV7t9lU8vNzeW.u"
    : (state.passwordHashes[user.id] ?? "");
  const valid = await verifyPassword(hash, parsed.data.password);
  if (user === undefined || !valid)
    return reply.status(401).send(fail("Invalid email or password", null));
  if (user.status.toLowerCase() !== "active")
    return reply.status(403).send(fail("User account is not active", null));
  // One acknowledged commit for both the refresh session and login timestamp.
  // A second whole-workspace persistence pass only extends writer contention.
  const session = await issueSession(user, parsed.data.rememberMe, services, new Date().toISOString());
  return reply.send(ok(session, "Login successful", null));
}

export async function register(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthenticationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const parsed = registerRequestSchema.safeParse(request.body);
  if (!parsed.success || parsed.data.name.trim() === "" || parsed.data.email.trim() === "" || parsed.data.password.length < 8)
    return reply.status(400).send(fail("Name, a valid email, and a password of at least 8 characters are required", null));
  if (!services.config.allowPublicRegistration)
    return reply.status(403).send(fail("Public registration is disabled", null));
  const passwordHash = await hashPassword(parsed.data.password);
  const user = await services.repository.mutate((state) => {
    if (Object.values(state.users).some((item) => item.email.toLowerCase() === parsed.data.email.trim().toLowerCase()))
      throw new AuthenticationFailure(409, "A user with this email already exists");
    state.counter += 1;
    const id = `usr_${state.counter}_${randomBytes(4).toString("hex")}`;
    const created: User = {
      id,
      name: parsed.data.name.trim(),
      email: parsed.data.email.trim().toLowerCase(),
      roleId: "role_client",
      permissionOverrides: [],
      status: "Active",
      initials: initials(parsed.data.name),
      departmentId: null,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    };
    state.users[id] = created;
    state.passwordHashes[id] = passwordHash;
    return created;
  }).catch((error: unknown) => {
    if (error instanceof AuthenticationFailure) return error;
    throw error;
  });
  if (user instanceof AuthenticationFailure)
    return reply.status(user.status).send(fail(user.message, null));
  return reply.status(201).send(ok(await issueSession(user, false, services), "Registration successful", null));
}

export async function refresh(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthenticationServices,
): Promise<unknown> {
  if (request.body === INVALID_JSON_BODY)
    return reply.status(400).send(fail("Invalid request body", null));
  const parsed = z.object({ refreshToken: z.string() }).strict().safeParse(request.body);
  if (!parsed.success || parsed.data.refreshToken === "")
    return reply.status(400).send(fail("Refresh token is required", null));
  const digest = sha256(parsed.data.refreshToken);
  const user = await services.repository.mutate((state) => {
    const session = state.refreshSessions[digest];
    if (session === undefined) return null;
    delete state.refreshSessions[digest];
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return state.users[session.userId] ?? null;
  });
  if (user === null || user.status.toLowerCase() !== "active")
    return reply.status(401).send(fail("Invalid or expired refresh token", null));
  return reply.send(ok(await issueSession(user, false, services), "Token refreshed", null));
}

export async function logout(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthenticationServices,
): Promise<unknown> {
  const token = isRecord(request.body) && typeof request.body.refreshToken === "string"
    ? request.body.refreshToken
    : "";
  if (token !== "")
    await services.repository.mutate((state) => { delete state.refreshSessions[sha256(token)]; });
  return reply.send(ok({ loggedOut: true }, "Logged out", null));
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  services: { config: Pick<ApplicationServices["config"], "jwtSecret">; repository: Pick<ApplicationServices["repository"], "effectiveUser"> },
): Promise<{ user: AuthenticatedUser } | null> {
  let token = "";
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) token = header.slice(7).trim();
  if (token === "" && request.url.startsWith("/ws/") && isRecord(request.query) && typeof request.query.token === "string")
    token = request.query.token;
  if (token === "") {
    await reply.status(401).send(fail("Missing access token", null));
    return null;
  }
  let subject: string;
  try {
    const claims = jwt.verify(token, services.config.jwtSecret, { algorithms: ["HS256"] });
    if (typeof claims === "string" || typeof claims.sub !== "string" || claims.sub.trim() === "") {
      await reply.status(401).send(fail("Invalid token subject", null));
      return null;
    }
    subject = claims.sub;
  } catch {
    await reply.status(401).send(fail("Invalid or expired access token", null));
    return null;
  }
  // Storage failure is not proof of an invalid token. Let the host expose its
  // sanitized availability response rather than log a user out on contention.
  const user = await services.repository.effectiveUser(subject);
  if (user === null) {
    await reply.status(401).send(fail("Authenticated user no longer exists", null));
    return null;
  }
  if (user.status.toLowerCase() !== "active") {
    await reply.status(403).send(fail("User account is not active", null));
    return null;
  }
  return { user };
}

export function publicAuthenticatedUser(
  user: (User & { role?: string; permissions?: string[] }) | null,
): Record<string, unknown> {
  if (user === null) return {};
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roleId: user.roleId,
    permissionOverrides: user.permissionOverrides,
    status: user.status,
    initials: user.initials,
    ...(user.timezone === undefined ? {} : { timezone: user.timezone }),
    departmentId: user.departmentId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    ...(user.twoFactorEnabled === undefined ? {} : { twoFactorEnabled: user.twoFactorEnabled }),
    ...(user.emailVerified === undefined ? {} : { emailVerified: user.emailVerified }),
    role: user.role ?? "",
    permissions: user.permissions ?? [],
  };
}

async function issueSession(user: User, remember: boolean, services: AuthenticationServices, loginAt?: string): Promise<Record<string, unknown>> {
  const accessToken = jwt.sign({}, services.config.jwtSecret, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: services.config.tokenTTLSeconds,
  });
  const refreshToken = `refresh_${randomBytes(24).toString("hex")}`;
  const days = remember ? 30 : 7;
  await services.repository.mutate((state) => {
    state.refreshSessions[sha256(refreshToken)] = {
      userId: user.id,
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    };
    if (loginAt !== undefined && state.users[user.id]) state.users[user.id]!.lastLoginAt = loginAt;
  });
  const effective = await services.repository.effectiveUser(user.id);
  return {
    accessToken,
    refreshToken,
    expiresIn: services.config.tokenTTLSeconds,
    user: publicAuthenticatedUser(effective!),
  };
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AuthenticationFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
