import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { liveErpTools } from "../src/registry/live-erp-tools.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { buildApp } from "../src/http/app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const remote = (name: string) => ({ name, description: `Live ${name}`, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, annotations: { readOnlyHint: true } });
async function fixture() {
  const repository = new Repository(null);
  await repository.mutate(state => { state.users.admin = { id: "admin", name: "Admin", email: "admin@example.test", roleId: "role_admin", status: "Active", permissionOverrides: [], initials: "AD", departmentId: null, createdAt: "", lastLoginAt: null }; });
  const user = (await repository.effectiveUser("admin"))!;
  const listTools = vi.fn(async () => Array.from({ length: 43 }, (_, index) => remote(`live_${String(index).padStart(3, "0")}`)));
  const session: any = { available: true, listTools, callTool: vi.fn() };
  const services: any = { repository, config: loadConfig({ APP_ENV: "test" }), erpbridgeSession: session,
    registries: { snapshot: () => ({ tools: [{ name: "hard_coded_tool" }] }) } };
  return { repository, user, services, session, listTools };
}
test("pages only live bridge summaries, never static registry tools or full schemas", async () => {
  const f = await fixture(), names: string[] = [];
  for (const offset of [0, 20, 40]) {
    const page: any = await liveErpTools(f.services, f.user, { source: "erpbridge", offset });
    expect(page.total).toBe(43); expect(page.tools.length).toBe(offset === 40 ? 3 : 20);
    expect(page.nextOffset).toBe(offset === 40 ? null : offset + 20);
    expect(page.tools.every((tool: any) => !Object.hasOwn(tool, "inputSchema"))).toBe(true);
    names.push(...page.tools.map((tool: any) => tool.name));
  }
  expect(new Set(names).size).toBe(43); expect(names).not.toContain("hard_coded_tool");
  expect(f.listTools).toHaveBeenCalledTimes(3); expect(f.session.callTool).not.toHaveBeenCalled();
});
test("refresh and details use fresh discovery; removed tools cannot retain a stale schema", async () => {
  const f = await fixture();
  const detail: any = await liveErpTools(f.services, f.user, { toolName: "live_000" });
  expect(detail.tool.inputSchema.required).toEqual(["name"]);
  f.listTools.mockResolvedValue([remote("newly_added")]);
  const page: any = await liveErpTools(f.services, f.user, { offset: 40 });
  expect(page).toMatchObject({ total: 1, offset: 0, nextOffset: null }); expect(page.tools[0].name).toBe("newly_added");
  await expect(liveErpTools(f.services, f.user, { toolName: "live_000" })).rejects.toMatchObject({ status: 404 });
});
test("search filters the live inventory while retaining its true total", async () => {
  const f = await fixture(), page: any = await liveErpTools(f.services, f.user, { search: "live_042" });
  expect(page).toMatchObject({ total: 43, matchedCount: 1 }); expect(page.tools.map((tool: any) => tool.name)).toEqual(["live_042"]);
});
test("all summaries are available in one lightweight response for client-side search and pagination", async () => {
  const f = await fixture(), page: any = await liveErpTools(f.services, f.user, { limit: "all" });
  expect(page.tools).toHaveLength(43); expect(page.nextOffset).toBeNull();
  expect(page.tools.every((tool: any) => !Object.hasOwn(tool, "inputSchema"))).toBe(true);
  expect(f.listTools).toHaveBeenCalledOnce();
});
test.each(["disconnected", "failed", "duplicate"])("%s bridge fails closed without static fallback or leaking upstream errors", async kind => {
  const f = await fixture();
  if (kind === "disconnected") f.services.erpbridgeSession = undefined;
  if (kind === "failed") f.listTools.mockRejectedValue(new Error("private-upstream-token"));
  if (kind === "duplicate") f.listTools.mockResolvedValue([remote("same"), remote("same")]);
  await expect(liveErpTools(f.services, f.user, {})).rejects.toMatchObject({ status: 503 });
  expect(f.session.callTool).not.toHaveBeenCalled();
});
test("unknown connections, invalid pagination, and authority revocation are not silently accepted", async () => {
  const f = await fixture();
  await expect(liveErpTools(f.services, f.user, { connectionId: "other" })).rejects.toMatchObject({ status: 404 });
  await expect(liveErpTools(f.services, f.user, { limit: 1000 })).rejects.toMatchObject({ status: 400 });
  f.listTools.mockImplementationOnce(async () => { await f.repository.mutate(state => { state.users.admin!.status = "Suspended"; }); return []; });
  await expect(liveErpTools(f.services, f.user, {})).rejects.toMatchObject({ status: 403 });
});
test("the actual modern HTTP registry route returns live pages, not its bundled registry", async () => {
  const f = await fixture(), config = loadConfig({ APP_ENV: "test" });
  config.mcpTransport = "erpbridge-mcp";
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, f.repository), executor = new Executor(new ToolRegistry(), validator);
  const app = await buildApp({ config, repository: f.repository, registries, validator, executor, erpbridgeSession: f.session }); apps.push(app);
  const authorization = `Bearer ${jwt.sign({}, config.jwtSecret, { subject: f.user.id, algorithm: "HS256", expiresIn: 60 })}`;
  const result = await app.inject({ method: "GET", url: "/api/registry/tools?offset=20&limit=20", headers: { authorization } });
  expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.json().data).toMatchObject({ source: "erpbridge", total: 43, offset: 20 });
  expect(result.json().data.tools[0].name).toBe("live_020");
  const denied = await app.inject({ method: "GET", url: "/api/registry/tools?source=erpbridge" }); expect(denied.statusCode).toBe(401);
});
