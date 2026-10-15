import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Workflow } from "../src/models/schemas.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";
import { stringify } from "yaml";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup(enabled: boolean, providerRuntime?: ProviderRuntime, environment = "test") {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "mandatory-auth-test-secret-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), environment };
  const repository = new Repository(null);
  await repository.mutate((state) => {
    state.settings.rbac = { enabled };
    for (const [id, roleId] of [["client", "role_client"], ["admin", "role_admin"]]) {
      state.users[id!] = { id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, permissionOverrides: [], status: "Active", initials: "T", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
    }
    state.workflows.other = workflow("other", "admin");
  });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository);
  const listTools = vi.fn(async () => []);
  const callToolDirect = vi.fn(async () => ({}));
  const app = await buildApp({ config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), ...(providerRuntime ? { providerRuntime } : {}), erpbridgeSession: { listTools, callToolDirect, close: async () => {}, clientFor: () => { throw new Error("No dispatch expected"); } } });
  apps.push(app);
  const headers = (id: string) => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  return { app, repository, registries, validator, headers, listTools, callToolDirect };
}

function workflow(id: string, ownerId: string, yaml = "name: Test\ndescription: A test workflow\ntrigger:\n  type: manual\nsteps:\n - id: bad\n   action: nonexistent.tool\n"): Workflow {
  const now = new Date().toISOString();
  return { id, name: "Test", description: "Test workflow", owner: { id: ownerId, name: ownerId }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: now, updatedAt: now, yaml, archived: false };
}

test("personal dashboard is authenticated, scoped, read-only and available to a client", async () => {
  const s = await setup(false), url = "/api/dashboard/tasks?month=2026-10&timezone=Asia%2FColombo", before = await s.repository.snapshot();
  expect((await s.app.inject({ method: "GET", url })).statusCode).toBe(401);
  const response = await s.app.inject({ method: "GET", url, headers: s.headers("client") });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ profile: "personal-task-dashboard/v1", scope: "personal", events: [], timezone: "Asia/Colombo" });
  expect(await s.repository.snapshot()).toEqual(before); expect(s.callToolDirect).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled();
});
test.each(["month=2026-13&timezone=UTC", "month=2026-10&timezone=Invalid", "month=2026-10&timezone=UTC&actor=admin"])("personal dashboard rejects invalid or authority-changing query %s", async query => {
  const s = await setup(false); expect((await s.app.inject({ method: "GET", url: `/api/dashboard/tasks?${query}`, headers: s.headers("client") })).statusCode).toBe(400);
});
test("personal dashboard cannot present current counts after authoritative storage denial", async () => {
  const s = await setup(false); vi.spyOn(s.repository, "readAuthoritative").mockRejectedValue(new Error("private storage exception"));
  const response = await s.app.inject({ method: "GET", url: "/api/dashboard/tasks?month=2026-10&timezone=UTC", headers: s.headers("client") });
  expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private storage"); expect(response.json().data).toBeNull();
});

describe.each([false, true])("mandatory authorization with advisory policy enabled=%s", (enabled) => {
  test("client cannot access administration, credentials or workflow writes", async () => {
    const s = await setup(enabled);
    for (const [method, url] of [["GET", "/api/users"], ["GET", "/api/settings"], ["GET", "/api/profile/api-keys"], ["GET", "/api/providers"], ["POST", "/api/workflows"], ["POST", "/api/import/commit"]] as const) {
      const response = await s.app.inject({ method, url, headers: s.headers("client"), ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(s.listTools).not.toHaveBeenCalled();
    expect(s.callToolDirect).not.toHaveBeenCalled();
  });
  test("unassigned run is denied before validation, discovery or dispatch", async () => {
    const s = await setup(enabled);
    const validation = vi.spyOn(s.validator, "validateAndIssueToken");
    const response = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("client"), payload: {} });
    expect(response.statusCode).toBe(403);
    expect(validation).not.toHaveBeenCalled();
    expect(s.listTools).not.toHaveBeenCalled();
    expect(s.callToolDirect).not.toHaveBeenCalled();
    expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(0);
  });
  test("admin access and client self-service still work", async () => {
    const s = await setup(enabled);
    expect((await s.app.inject({ method: "GET", url: "/api/settings", headers: s.headers("admin") })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: s.headers("client") })).statusCode).toBe(200);
  });
});

test("malformed or unknown-tool run is rejected before provider or ERP discovery", async () => {
  const s = await setup(false);
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("admin"), payload: {} });
  expect(response.statusCode).toBe(422);
  expect(response.json().message).toBe("Workflow validation failed");
  expect(s.listTools).not.toHaveBeenCalled();
  expect(s.callToolDirect).not.toHaveBeenCalled();
});

test("production exposes a release-immutable registry and rejects filesystem mutations", async () => {
  const s = await setup(false, undefined, "production");
  const status = await s.app.inject({ method: "GET", url: "/api/registry/status", headers: s.headers("admin") });
  expect(status.statusCode, status.body).toBe(200);
  expect(status.json().data).toMatchObject({ mode: "release-immutable", writable: false,
    tools: { path: "release://registry/tools" }, rules: { path: "release://registry/rules" } });
  expect(JSON.stringify(status.json().data)).not.toContain(process.cwd());

  for (const [url, payload] of [
    ["/api/registry/tools", {}],
    ["/api/registry/rules", {}],
    ["/api/registry/context/regenerate", {}],
    ["/api/import/commit", { analysisId: "untrusted" }],
  ] as const) {
    const response = await s.app.inject({ method: "POST", url, headers: s.headers("admin"), payload });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(403);
    expect(response.json().message).toContain("release-managed and immutable");
  }
  expect((await s.repository.snapshot()).registryContextHistory).toEqual([]);
});

test("generation acceptance preserves exact YAML, version and runtime checkpoints", async () => {
  const s = await setup(false);
  const yaml = "name: Approval\ndescription: Require a person to approve each run\ntrigger:\n  type: manual\nsteps:\n - id: approve\n   kind: approval\n   description: Manager approves this transaction\n";
  await s.repository.mutate((state) => { state.workflows.approval = { ...workflow("approval", "admin", yaml), pendingGenerationApproval: { steps: [{ stepId: "approve", description: "Manager approves this transaction" }], requestedAt: new Date().toISOString() } }; });
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/approval/approve-generation", headers: s.headers("admin"), payload: {} });
  expect(response.statusCode, response.body).toBe(200);
  const saved = (await s.repository.snapshot()).workflows.approval!;
  expect(saved.yaml).toBe(yaml);
  expect(saved.draftVersion).toBe(1);
  expect(saved.pendingGenerationApproval).toBeNull();
  expect(saved.generationApprovals).toHaveLength(1);
  const run = await s.app.inject({ method: "POST", url: "/api/workflows/approval/run", headers: s.headers("admin"), payload: {} });
  expect(run.statusCode).toBe(409);
  expect(run.json().meta.code).toBe("RUNTIME_APPROVAL_EXECUTOR_REQUIRED");
  expect(s.listTools).not.toHaveBeenCalled();
  expect(s.callToolDirect).not.toHaveBeenCalled();
});

test("legacy approval resume cannot grant approval or dispatch through a model prompt", async () => {
  const s = await setup(false);
  await s.repository.mutate((state) => { state.executions.legacy = { id: "legacy", workflowId: "other", workflowName: "Legacy", status: "AWAITING_APPROVAL",
    startedAt: new Date().toISOString(), completedAt: null, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0,
    startedBy: { id: "admin", name: "Admin" }, pendingApproval: { stepId: "approve", description: "Approve payment", requestedAt: new Date().toISOString() } }; });
  const before = structuredClone((await s.repository.snapshot()).executions.legacy);
  const response = await s.app.inject({ method: "POST", url: "/api/executions/legacy/approve", headers: s.headers("admin"), payload: { note: "Approved" } });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().meta.code).toBe("RUNTIME_APPROVAL_EXECUTOR_REQUIRED");
  expect((await s.repository.snapshot()).executions.legacy).toEqual(before);
  expect(s.listTools).not.toHaveBeenCalled();
  expect(s.callToolDirect).not.toHaveBeenCalled();
});

const readYaml = "name: Read\ndescription: Read echo\ntrigger:\n  type: manual\nsteps:\n - id: read\n   action: demo.echo\n   parameters:\n     value: test\n";
test("accepting a valid candidate creates a draft, not an executable publication", async () => {
  const s = await setup(false);
  const response = await s.app.inject({ method: "POST", url: "/api/workflows", headers: s.headers("admin"), payload: { candidate: { yaml: readYaml } } });
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json().data.id;
  const snapshot = await s.repository.snapshot();
  expect(snapshot.workflows[id]).toMatchObject({ yaml: readYaml, publishedVersion: 0, draftVersion: 1, canRun: false });
  expect(snapshot.versions[id]?.[0]?.artifactState).toBe("DRAFT");
  const run = await s.app.inject({ method: "POST", url: `/api/workflows/${id}/run`, headers: s.headers("admin"), payload: {} });
  expect(run.statusCode, run.body).toBe(409);
  expect(run.json().meta.code).toBe("WORKFLOW_NOT_PUBLISHED");
  expect(s.listTools).not.toHaveBeenCalled();
});

test("duplicate revalidates the exact source and creates a clean non-runnable draft without provenance or execution state", async () => {
  const s = await setup(false);
  await s.repository.mutate((state) => {
    state.workflows.other = {
      ...workflow("other", "admin", readYaml),
      name: "Reviewed source",
      publishedVersion: 7,
      draftVersion: 9,
      canRun: true,
      tags: ["finance"],
      domainTags: ["invoices"],
      lastRunAt: new Date().toISOString(),
      chatSessionId: "chat-private",
      chatMessageId: "message-private",
      traceId: "trace-private",
      pendingGenerationApproval: { steps: [{ stepId: "old", description: "Old proposal evidence" }], requestedAt: new Date().toISOString() },
      generationApprovals: [{ approvedBy: { id: "admin", name: "admin" }, approvedAt: new Date().toISOString() }],
      canvas: { workflowId: "other", nodes: [{ id: "read", status: "succeeded", result: { private: true } }], edges: [] },
    };
  });
  const validation = vi.spyOn(s.validator, "validateAndIssueToken");
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/other/duplicate", headers: s.headers("admin"), payload: { name: "Safe copy" } });
  expect(response.statusCode, response.body).toBe(201);
  expect(validation).toHaveBeenCalledWith("DuplicateWorkflow", readYaml, "Platform Admin", expect.objectContaining({ workflowId: "other" }));
  const id = response.json().data.id as string, state = await s.repository.snapshot(), copy = state.workflows[id]!;
  expect(copy).toMatchObject({ name: "Safe copy", owner: { id: "admin" }, assignedUserIds: [], publishedVersion: 0, draftVersion: 1,
    canRun: false, lastRunAt: null, tags: ["finance"], domainTags: ["invoices"], yaml: readYaml, archived: false });
  expect(copy).not.toHaveProperty("chatSessionId");
  expect(copy).not.toHaveProperty("chatMessageId");
  expect(copy).not.toHaveProperty("traceId");
  expect(copy).not.toHaveProperty("pendingGenerationApproval");
  expect(copy).not.toHaveProperty("generationApprovals");
  expect(copy.canvas).toMatchObject({ workflowId: id, nodes: [{ id: "read", status: "idle" }] });
  expect(JSON.stringify(copy.canvas)).not.toContain("private");
  expect(state.versions[id]).toBeUndefined();
  expect(state.auditLogs).toContainEqual(expect.objectContaining({ action: "workflow.duplicated", resource: { type: "workflow", id },
    after: expect.objectContaining({ sourceWorkflowId: "other", sourceVersion: 9, canRun: false }) }));
  const run = await s.app.inject({ method: "POST", url: `/api/workflows/${id}/run`, headers: s.headers("admin"), payload: {} });
  expect(run.statusCode, run.body).toBe(409);
  expect(run.json().meta.code).toBe("WORKFLOW_NOT_PUBLISHED");
  expect(s.listTools).not.toHaveBeenCalled();
});

test("duplicate rejects invalid, changed, and authority-revoked sources without creating a copy", async () => {
  const invalid = await setup(false);
  const denied = await invalid.app.inject({ method: "POST", url: "/api/workflows/other/duplicate", headers: invalid.headers("admin"), payload: {} });
  expect(denied.statusCode, denied.body).toBe(422);
  expect(Object.keys((await invalid.repository.snapshot()).workflows)).toEqual(["other"]);

  const changed = await setup(false);
  await changed.repository.mutate((state) => { state.workflows.other = workflow("other", "admin", readYaml); });
  const changedOriginal = changed.validator.validateAndIssueToken.bind(changed.validator);
  vi.spyOn(changed.validator, "validateAndIssueToken").mockImplementationOnce(async (...args) => {
    const result = await changedOriginal(...args);
    await changed.repository.mutate((state) => { state.workflows.other!.yaml = readYaml.replace("value: test", "value: changed"); state.workflows.other!.draftVersion++; });
    return result;
  });
  const conflict = await changed.app.inject({ method: "POST", url: "/api/workflows/other/duplicate", headers: changed.headers("admin"), payload: {} });
  expect(conflict.statusCode, conflict.body).toBe(409);
  expect(conflict.json().meta.code).toBe("WORKFLOW_CHANGED");
  expect(Object.keys((await changed.repository.snapshot()).workflows)).toEqual(["other"]);

  const revoked = await setup(false);
  await revoked.repository.mutate((state) => { state.workflows.other = workflow("other", "admin", readYaml); });
  const revokedOriginal = revoked.validator.validateAndIssueToken.bind(revoked.validator);
  vi.spyOn(revoked.validator, "validateAndIssueToken").mockImplementationOnce(async (...args) => {
    const result = await revokedOriginal(...args);
    await revoked.repository.mutate((state) => { state.users.admin!.status = "Suspended"; });
    return result;
  });
  const forbidden = await revoked.app.inject({ method: "POST", url: "/api/workflows/other/duplicate", headers: revoked.headers("admin"), payload: {} });
  expect(forbidden.statusCode, forbidden.body).toBe(403);
  expect(Object.keys((await revoked.repository.snapshot()).workflows)).toEqual(["other"]);
});

test("template use and workflow import validate into non-runnable drafts", async () => {
  const s = await setup(false);
  await s.repository.mutate((state) => { state.templates.safe = { id: "safe", name: "Safe template", description: "Read only", yaml: readYaml }; });
  const template = await s.app.inject({ method: "POST", url: "/api/workflows/templates/safe/use", headers: s.headers("admin"), payload: { name: "From template" } });
  expect(template.statusCode, template.body).toBe(201);
  expect(template.json().data).toMatchObject({ name: "From template", publishedVersion: 0, draftVersion: 1, canRun: false });
  const imported = await s.app.inject({ method: "POST", url: "/api/upload/workflow-import", headers: s.headers("admin"), payload: { name: "Imported", yaml: readYaml } });
  expect(imported.statusCode, imported.body).toBe(201);
  expect(imported.json().data).toMatchObject({ name: "Imported", publishedVersion: 0, draftVersion: 1, canRun: false });
  for (const id of [template.json().data.id, imported.json().data.id]) {
    const run = await s.app.inject({ method: "POST", url: `/api/workflows/${id}/run`, headers: s.headers("admin"), payload: {} });
    expect(run.statusCode, run.body).toBe(409);
    expect(run.json().meta.code).toBe("WORKFLOW_NOT_PUBLISHED");
  }
  expect(s.listTools).not.toHaveBeenCalled();
  expect(s.callToolDirect).not.toHaveBeenCalled();
});

const creationOrigins = ["create", "duplicate", "template", "import"] as const;
async function originSetup(origin: typeof creationOrigins[number], yaml = readYaml) {
  const s = await setup(false);
  await s.repository.mutate(state => {
    state.workflows.other = workflow("other", "admin", yaml);
    state.templates.safe = { id: "safe", name: "Safe", yaml };
  });
  const request = () => s.app.inject({ method: "POST", headers: s.headers("admin"),
    url: origin === "create" ? "/api/workflows" : origin === "duplicate" ? "/api/workflows/other/duplicate" :
      origin === "template" ? "/api/workflows/templates/safe/use" : "/api/upload/workflow-import",
    payload: origin === "create" || origin === "import" ? { yaml } : {},
  });
  return { ...s, request };
}

test.each(creationOrigins)("%s rejects actor revocation during validation before saving any draft", async origin => {
  const s = await originSetup(origin), validate = s.validator.validateAndIssueToken.bind(s.validator);
  vi.spyOn(s.validator, "validateAndIssueToken").mockImplementationOnce(async (...args) => {
    const result = await validate(...args);
    expect(result.result.passed).toBe(true);
    await s.repository.mutate(state => { state.users.admin!.status = "Suspended"; });
    return result;
  });
  const response = await s.request();
  expect(response.statusCode, response.body).toBe(403);
  expect(Object.keys((await s.repository.snapshot()).workflows)).toEqual(["other"]);
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callToolDirect).not.toHaveBeenCalled();
});

test.each(creationOrigins)("%s rejects registry drift during validation before saving any draft", async origin => {
  const s = await originSetup(origin), validate = s.validator.validateAndIssueToken.bind(s.validator);
  vi.spyOn(s.validator, "validateAndIssueToken").mockImplementationOnce(async (...args) => {
    const result = await validate(...args);
    expect(result.result.passed).toBe(true);
    vi.spyOn(s.registries, "hash").mockReturnValue(`sha256:${"f".repeat(64)}`);
    return result;
  });
  const response = await s.request();
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().meta.code).toBe("DRAFT_REGISTRY_CHANGED");
  expect(Object.keys((await s.repository.snapshot()).workflows)).toEqual(["other"]);
});

test.each(creationOrigins)("%s applies structural ownership checks even when registry validation passes", async origin => {
  const blueprint = parseWorkflowYAMLStrict(readYaml);
  blueprint.metadata = { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [] } } };
  const s = await originSetup(origin, stringify(blueprint));
  expect(s.validator.validatePlan("Fixture", stringify(blueprint), "Platform Admin").passed).toBe(true);
  const response = await s.request();
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().meta.errors.join(" ")).toContain("Control flow must own every declared action exactly once");
  expect(Object.keys((await s.repository.snapshot()).workflows)).toEqual(["other"]);
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callToolDirect).not.toHaveBeenCalled();
});

test("template use rejects a source changed or deleted during validation", async () => {
  for (const damage of ["change", "delete"] as const) {
    const s = await originSetup("template"), validate = s.validator.validateAndIssueToken.bind(s.validator);
    vi.spyOn(s.validator, "validateAndIssueToken").mockImplementationOnce(async (...args) => {
      const result = await validate(...args);
      await s.repository.mutate(state => { if (damage === "delete") delete state.templates.safe; else state.templates.safe!.yaml = readYaml.replace("value: test", "value: changed"); });
      return result;
    });
    const response = await s.request();
    expect(response.statusCode, response.body).toBe(409); expect(response.json().meta.code).toBe("TEMPLATE_CHANGED");
    expect(Object.keys((await s.repository.snapshot()).workflows)).toEqual(["other"]);
  }
});

test("direct creation rechecks linked chat origin after validation", async () => {
  const s = await setup(false), timestamp = new Date().toISOString();
  await s.repository.mutate(state => { state.chats.origin = { id: "origin", title: "Origin", ownerId: "admin", createdAt: timestamp,
    updatedAt: timestamp, messageCount: 1, messages: [{ id: "request", role: "user", text: "Build a read", createdAt: timestamp }] }; });
  const validate = s.validator.validateAndIssueToken.bind(s.validator);
  vi.spyOn(s.validator, "validateAndIssueToken").mockImplementationOnce(async (...args) => {
    const result = await validate(...args);
    await s.repository.mutate(state => { delete state.chats.origin; });
    return result;
  });
  const response = await s.app.inject({ method: "POST", url: "/api/workflows", headers: s.headers("admin"),
    payload: { candidate: { yaml: readYaml, chatSessionId: "origin", chatMessageId: "request" } } });
  expect(response.statusCode, response.body).toBe(409); expect(response.json().meta.code).toBe("CHAT_ORIGIN_CHANGED");
  expect(Object.keys((await s.repository.snapshot()).workflows)).toEqual(["other"]);
});

test.each(["read-dispatch-error", "write-blocked"])("published run handles %s without asking a model to execute", async (scenario) => {
  const queryWithTools = vi.fn(async () => { throw new Error("A published read must not ask the model to execute"); });
  const s = await setup(false, { configured: true, queryWithTools } as unknown as ProviderRuntime);
  const tool = { ...s.registries.snapshot().tools[0]!, allowed_roles: ["Platform Admin"], is_read_only: scenario !== "write-blocked" };
  const snapshot = s.registries.snapshot();
  vi.spyOn(s.registries, "snapshot").mockReturnValue({ ...snapshot, tools: [tool] });
  vi.spyOn(s.registries, "findTool").mockImplementation((name) => name === tool.name ? tool : undefined);
  s.listTools.mockResolvedValue([{ name: "demo.echo", inputSchema: tool.input_schema }] as never);
  await s.repository.mutate((state) => {
    state.workflows.other = { ...workflow("other", "admin", readYaml), publishedVersion: 1 };
    state.versions.other = [{ version: 1, artifactState: "PUBLISHED", yaml: readYaml }];
  });
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("admin"), payload: {} });
  expect(response.statusCode, response.body).toBe(422);
  const state = await s.repository.snapshot();
  expect(queryWithTools).not.toHaveBeenCalled();
  if (scenario === "write-blocked") {
    expect(response.json().meta.code).toBe("UNSUPPORTED_EXECUTION_PROFILE");
    expect(state.executions).toEqual({});
    expect(s.listTools).not.toHaveBeenCalled();
    return;
  }
  const execution = Object.values(state.executions)[0]!;
  expect(execution.status).toBe("RECOVERY_REQUIRED");
  expect(execution.failure?.failureCategory).toBe("READ_OUTCOME_UNKNOWN");
  expect(execution.agentSummary).not.toBe("Completed successfully");
  expect(execution.stepOutputs).toEqual({});
  expect(state.timelines[execution.id]?.[0]).toMatchObject({ nodeId: "read", status: "UNKNOWN", outcome: "UNKNOWN" });
});

test("editing a published draft invalidates the runnable snapshot before discovery", async () => {
  const s = await setup(false);
  await s.repository.mutate((state) => {
    state.workflows.other = { ...workflow("other", "admin", readYaml), publishedVersion: 1 };
    state.versions.other = [{ version: 1, artifactState: "PUBLISHED", yaml: readYaml.replace("value: test", "value: old") }];
  });
  const run = await s.app.inject({ method: "POST", url: "/api/workflows/other/run", headers: s.headers("admin"), payload: {} });
  expect(run.statusCode, run.body).toBe(409);
  expect(run.json().meta.code).toBe("PUBLISHED_SNAPSHOT_REQUIRED");
  expect(s.listTools).not.toHaveBeenCalled();
});
