import Fastify from "fastify";
import { expect, test, vi } from "vitest";
import { login } from "../src/http/handlers/authentication.js";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { hashPassword } from "../src/authn/password.js";

test("a successful sign-in persists the refresh session and last login in one commit", async () => {
  const repository = new Repository(null), password = "fixture-sign-in-password";
  const passwordHash = await hashPassword(password);
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [],
      status: "Active", initials: "OW", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
    state.passwordHashes.owner = passwordHash;
  });
  const mutate = vi.spyOn(repository, "mutate"), app = Fastify();
  app.post("/login", (request, reply) => login(request, reply, { repository, config: loadConfig({ APP_ENV: "test" }) }));
  try {
    const response = await app.inject({ method: "POST", url: "/login", payload: { email: "owner@example.test", password } });
    expect(response.statusCode).toBe(200); expect(mutate).toHaveBeenCalledOnce();
    const state = await repository.snapshot(); expect(Object.keys(state.refreshSessions)).toHaveLength(1);
    expect(state.users.owner!.lastLoginAt).toEqual(expect.any(String));
    expect(response.json().data.user.lastLoginAt).toBe(state.users.owner!.lastLoginAt);
    expect(response.json().data.user).not.toHaveProperty("passwordHash");
    mutate.mockClear(); const before = await repository.snapshot();
    expect((await app.inject({ method: "POST", url: "/login", payload: { email: "owner@example.test", password: "incorrect" } })).statusCode).toBe(401);
    expect(mutate).not.toHaveBeenCalled(); expect(await repository.snapshot()).toEqual(before);
  } finally { await app.close(); await repository.close(); }
});
