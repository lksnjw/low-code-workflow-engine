import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../../config/config.js";
import type { RegistryService } from "../../registry/service.js";
import type { Repository, RepositoryState, User } from "../../repository/store.js";
import type { Executor } from "../../runner/executor.js";
import type { ProviderRuntime } from "../../providers/runtime.js";
import type { SynthesisService } from "../../synthesis/service.js";
import type { RegistryValidator } from "../../validator/registry-validator.js";
import type { GovernedValidationContext, ValidationGateResult } from "../../governance/gate.js";
import { projectGateExplanation, type GateExplanation } from "../../governance/explain.js";
import { requestTraceId } from "../../trace/request-trace.js";
import { attachValidationAuditTrace } from "../../trace/audit-trace.js";
import type { ErpbridgeMcpSession } from "../../tools/erpbridge-mcp-client.js";

export type CurrentUser = User & { role: string; permissions: string[] };
export type HandlerServices = {
  config: AppConfig;
  repository: Repository;
  registries: RegistryService;
  validator: RegistryValidator;
  validationGate?: import("../../governance/gate.js").ValidationGate;
  executor: Executor;
  providerRuntime?: ProviderRuntime;
  synthesis?: SynthesisService;
  erpbridgeSession?: ErpbridgeMcpSession;
  contextAvailable?: boolean;
};

export type EnrichedValidationResult = ValidationGateResult & { gateExplanation?: GateExplanation };

export async function validateWorkflow(
  services: HandlerServices,
  action: string,
  rawYAML: string,
  user: Pick<CurrentUser, "id" | "role" | "departmentId">,
  context: GovernedValidationContext = {},
): Promise<EnrichedValidationResult> {
  let gate: ValidationGateResult;
  if (services.validationGate === undefined) {
    gate = await services.validator.validateAndIssueToken(action, rawYAML, user.role);
    await attachValidationAuditTrace(services.repository, action, rawYAML, {
      ...context,
      actor: { id: user.id, role: user.role },
    });
  } else {
    gate = await services.validationGate.validateAndIssueToken(action, rawYAML, {
      id: user.id,
      role: user.role,
      department: user.departmentId,
    }, context);
  }
  if (!gate.result.passed) {
    const failedRules = Array.isArray((gate.result as Record<string, unknown>).failed_rules)
      ? (gate.result as Record<string, unknown>).failed_rules as string[]
      : [];
    return { ...gate, gateExplanation: projectGateExplanation(failedRules, services.registries) };
  }
  return gate;
}

export function requestParam(request: FastifyRequest, name: string): string {
  return String((request.params as Record<string, unknown>)[name] ?? "");
}

export function queryRecord(request: FastifyRequest): Record<string, unknown> {
  return isRecord(request.query) ? request.query : {};
}

export function bodyRecord(request: FastifyRequest): Record<string, unknown> | null {
  return isRecord(request.body) && request.body.invalidJSONBody !== true ? request.body : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return fallback;
}

export function nextID(state: RepositoryState, prefix: string): string {
  state.counter += 1;
  return `${prefix}_${state.counter}_${randomBytes(4).toString("hex")}`;
}

export function now(): string { return new Date().toISOString(); }

export function pageValues(request: FastifyRequest): { page: number; limit: number } {
  const query = queryRecord(request);
  return { page: Math.max(1, Math.trunc(numberValue(query.page, 1))), limit: Math.max(1, Math.trunc(numberValue(query.limit, 20))) };
}

export function paginate<T>(items: T[], request: FastifyRequest): { items: T[]; meta: { page: number; limit: number; total: number; totalPages: number } } {
  const { page, limit } = pageValues(request);
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return { items: items.slice((page - 1) * limit, page * limit), meta: { page, limit, total, totalPages } };
}

export function appendAudit(
  state: RepositoryState,
  actor: CurrentUser,
  action: string,
  resourceType: string,
  resourceID: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  request?: FastifyRequest,
): void {
  const id = nextID(state, "audit");
  state.auditLogs.push({
    id,
    actor: { id: actor.id, name: actor.name },
    action,
    resource: { type: resourceType, id: resourceID },
    ipAddress: request?.ip ?? "",
    userAgent: stringValue(request?.headers["user-agent"]),
    before,
    after,
    createdAt: now(),
    ...(request === undefined ? {} : { traceId: requestTraceId(request) }),
  });
}

export function publicUser(user: User): Record<string, unknown> {
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
  };
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export class HandlerFailure extends Error {
  constructor(readonly status: number, message: string, readonly meta: unknown = null) { super(message); }
}
