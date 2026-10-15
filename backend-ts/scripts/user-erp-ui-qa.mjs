// Loopback-only, memory-only UI QA. No owner .env, real token or ERP network.
import { resolve } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { Repository } from "../src/repository/store.ts";
import { RegistryService } from "../src/registry/service.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { Executor } from "../src/runner/executor.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { UserMcpCredentials } from "../src/tools/user-mcp-credentials.ts";
import { buildApp } from "../src/http/app.ts";
import { hashPassword } from "../src/authn/password.ts";
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", STORAGE_ENCRYPTION_KEY: "x".repeat(32),
  JWT_SECRET: "local-user-erp-ui-qa-only-at-least-32-chars", MCP_MODE: "mock", CORS_ORIGINS: "http://127.0.0.1:5197" });
// Explicit catalog fixture, not a cloud configuration or role grant.
config.erpbridgeConnections = [{ id: "erpbridge-default", baseURL: "https://erp-fixture.invalid", mcpToken: "CATALOG-FIXTURE-NOT-A-USER", tokenReference: "QA_ONLY", roleMap: {}, primary: true }];
const repository = new Repository();
const passwordHash = await hashPassword("Local-QA-only-2026!");
await repository.mutate(state => { for (const id of ["alice", "bob"]) {
  state.users[id] = { id, name: `${id} UI QA`, email: `${id}@example.test`, roleId: "role_builder", status: "Active", permissionOverrides: [], initials: id[0].toUpperCase(), departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
  state.passwordHashes[id] = passwordHash;
} });
const credentials = new UserMcpCredentials(repository, config, ({ token }) => ({ metadataComplete: true,
  connect: async () => { if (!token.startsWith("QA-")) throw new Error("Synthetic fixture rejects this token"); },
  listTools: async () => [], close: async () => {}, callTool: async () => { throw new Error("Business calls forbidden in this UI-only fixture"); } }));
const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
const validator = new RegistryValidator(registries, repository);
const app = await buildApp({ config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), userMcpCredentials: credentials });
await app.listen({ host: "127.0.0.1", port: 18196 });
console.log("Isolated user ERP UI QA: API 127.0.0.1:18196, frontend 127.0.0.1:5197. alice@example.test or bob@example.test; Local-QA-only-2026!; synthetic tokens begin QA-. No real ERP/network/persistence.");
let closing;
const close = () => closing ??= (async () => { await app.close(); credentials.close(); await repository.close(); })();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close().then(() => process.exit(0)); });
