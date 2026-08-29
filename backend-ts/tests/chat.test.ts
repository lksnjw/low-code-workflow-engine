import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, test } from "vitest";
import { hashPassword } from "../src/authn/password.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import {
  ProviderRuntime,
  type RuntimeProviderConfiguration,
} from "../src/providers/runtime.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { Executor } from "../src/runner/executor.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { GenericMCPTool } from "../src/tools/generic-mcp-tool.js";
import { createGovernedMCPClient } from "../src/tools/mcp-client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { GovernanceAdapter } from "../src/governance/adapter.js";
import { GovernedValidationGate } from "../src/governance/gate.js";
import { GovernanceService } from "../src/governance/service.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("chat orchestration", () => {
  test("stores user and assistant messages with a validated candidate while preserving the frontend response contract", async () => {
    const prompts: string[] = [];
    const yaml = `name: Echo request\ndescription: Echoes a value through the demo integration.\ntrigger:\n  type: manual\nsteps:\n  - id: echo_value\n    action: demo.echo\n    parameters:\n      value: hello\n`;
    const setup = await buildTestApplication(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      prompts.push(body.messages[0]!.content);
      return Response.json({
        choices: [{ message: { content: yaml } }],
        usage: { prompt_tokens: 25, completion_tokens: 15 },
      });
    });
    const response = await setup.app.inject({
      method: "POST",
      url: "/api/chat/sessions/chat_demo/messages",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { content: "Echo hello" },
    });
    expect(response.statusCode).toBe(200);
    const envelope = response.json();
    expect(envelope.message).toBe("Message processed");
    expect(envelope.data.userMessage.role).toBe("user");
    expect(envelope.data.assistantMessage.role).toBe("assistant");
    expect(envelope.data.assistantMessage.artifacts.can_execute).toBe(true);
    expect(envelope.data.workflowDraft.validation.passed).toBe(true);
    expect(envelope.data.usage).toEqual({
      inputTokens: 25,
      outputTokens: 15,
      measured: true,
    });
    const chat = (await setup.repository.snapshot()).chats.chat_demo!;
    expect(chat.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(chat.messages[1]?.artifacts).toBeDefined();

    await setup.app.inject({
      method: "POST",
      url: "/api/chat/sessions/chat_demo/messages",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { content: "Do it again" },
    });
    expect(prompts[1]).toContain("user: Echo hello");
    expect(prompts[1]).toContain("assistant: I generated a workflow candidate");
  });

  test("deploys a generated candidate through the existing workflow route and revalidates before persistence", async () => {
    const yaml = `name: Echo request\ndescription: Echoes a value through the demo integration.\ntrigger:\n  type: manual\nsteps:\n  - id: echo_value\n    action: demo.echo\n    parameters:\n      value: deployed\n`;
    const setup = await buildTestApplication(async () =>
      Response.json({ choices: [{ message: { content: yaml } }] }),
    );
    const generated = await setup.app.inject({
      method: "POST",
      url: "/api/chat/sessions/chat_deploy/messages",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { content: "Echo deployed" },
    });
    const candidate = generated.json().data.workflowDraft;
    const deployed = await setup.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { candidate },
    });
    expect(deployed.statusCode).toBe(201);
    const workflowID = deployed.json().data.id as string;
    const state = await setup.repository.snapshot();
    expect(state.workflows[workflowID]?.yaml).toBe(yaml.trim());
    expect(state.workflows[workflowID]?.publishedVersion).toBe(1);
    expect(state.workflows[workflowID]?.chatSessionId).toBe("chat_deploy");
    expect(state.workflows[workflowID]?.chatMessageId).toBe(
      generated.json().data.userMessage.id,
    );
    expect(state.versions[workflowID]).toHaveLength(1);

    const tampered = {
      ...candidate,
      yaml: yaml.replace("demo.echo", "hallucinated.tool"),
    };
    const rejected = await setup.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { candidate: tampered },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().meta.failed_rules).toContain("GLOBAL-SAFETY-001");
  });

  test("completes chat to validated deployment to realistic mock ERP execution and returns the result", async () => {
    const yaml = `name: Attendance lookup\ndescription: Fetches an employee attendance record from the ERP.\ntrigger:\n  type: manual\nsteps:\n  - id: fetch_employee_attendance\n    action: fetch_attendance\n    parameters:\n      employeeId: EMP-005\n`;
    const setup = await buildTestApplication(
      async () =>
        Response.json({
          choices: [{ message: { content: yaml } }],
          usage: { prompt_tokens: 41, completion_tokens: 27 },
        }),
      "fixtures/parity/http/runtime/all_tools_master_registry.json",
      "fixtures/parity/http/runtime/all_rules_master_registry.json",
    );
    const chat = await setup.app.inject({
      method: "POST",
      url: "/api/chat/sessions/chat_e2e/messages",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { content: "Show attendance for employee EMP-005" },
    });
    expect(chat.statusCode).toBe(200);
    const candidate = chat.json().data.workflowDraft;
    expect(candidate.validation.passed).toBe(true);

    const deploy = await setup.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { candidate },
    });
    expect(deploy.statusCode).toBe(201);
    const workflowID = deploy.json().data.id as string;

    const run = await setup.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowID}/run`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().data.status).toBe("DONE");
    expect(run.json().data.chatSessionId).toBe("chat_e2e");
    expect(run.json().data.finalOutput).toEqual({
      attendance: [
        {
          employeeId: "EMP-005",
          date: "2026-07-15",
          hours: 8,
          status: "present",
        },
      ],
      count: 1,
    });
    const state = await setup.repository.snapshot();
    expect(state.executions[run.json().data.id]?.status).toBe("DONE");
    expect(state.executions[run.json().data.id]?.chatSessionId).toBe(
      "chat_e2e",
    );
    expect(Object.values(state.invocationProvenance)).toHaveLength(1);

    const correlated = await setup.app.inject({
      method: "GET",
      url: "/api/executions?chatSessionId=chat_e2e",
      headers: { authorization: `Bearer ${setup.token}` },
    });
    expect(correlated.statusCode).toBe(200);
    expect(correlated.json().data.map((item: { id: string }) => item.id)).toEqual(
      [run.json().data.id],
    );

    const otherUser = await setup.repository.mutate((repositoryState) => {
      const value = {
        id: "usr_other_client",
        name: "Other Client",
        email: "other@example.test",
        roleId: "role_client",
        permissionOverrides: [],
        status: "Active",
        initials: "OC",
        departmentId: null,
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
      };
      repositoryState.users[value.id] = value;
      return value;
    });
    const otherToken = jwt.sign({}, setup.config.jwtSecret, {
      algorithm: "HS256",
      subject: otherUser.id,
      expiresIn: 3600,
    });
    const hiddenList = await setup.app.inject({
      method: "GET",
      url: "/api/executions?chatSessionId=chat_e2e",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(hiddenList.statusCode).toBe(200);
    expect(hiddenList.json().data).toEqual([]);
    const hiddenDetail = await setup.app.inject({
      method: "GET",
      url: `/api/executions/${run.json().data.id}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(hiddenDetail.statusCode).toBe(404);
  });

  test("redacts credential-shaped tool result keys before execution persistence and response", async () => {
    const yaml = `name: Redacted echo\ndescription: Verifies execution output redaction.\ntrigger:\n  type: manual\nsteps:\n  - id: echo_value\n    action: demo.echo\n    parameters:\n      value: safe\n`;
    const setup = await buildTestApplication(async () =>
      Response.json({ choices: [{ message: { content: yaml } }] }),
    );
    setup.tools.register({
      name: "demo.echo",
      description: "Returns a result containing credential-shaped fields.",
      async execute() {
        return {
          value: "safe",
          api_key: "must-not-escape",
          nested: { status: "ok", authorization: "Bearer must-not-escape" },
        };
      },
    });

    const chat = await setup.app.inject({
      method: "POST",
      url: "/api/chat/sessions/chat_redaction/messages",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { content: "Echo a safe value" },
    });
    const deploy = await setup.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { candidate: chat.json().data.workflowDraft },
    });
    const run = await setup.app.inject({
      method: "POST",
      url: `/api/workflows/${deploy.json().data.id}/run`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: {},
    });

    expect(run.statusCode).toBe(200);
    expect(run.json().data.stepOutputs.echo_value).toEqual({
      value: "safe",
      nested: { status: "ok" },
    });
    expect(run.json().data.finalOutput).toEqual({
      value: "safe",
      nested: { status: "ok" },
    });
    expect(JSON.stringify(run.json().data)).not.toContain("must-not-escape");

    const executionID = run.json().data.id as string;
    const persisted = (await setup.repository.snapshot()).executions[executionID]!;
    expect(persisted.stepOutputs?.echo_value).toEqual({
      value: "safe",
      nested: { status: "ok" },
    });
    const detail = await setup.app.inject({
      method: "GET",
      url: `/api/executions/${executionID}`,
      headers: { authorization: `Bearer ${setup.token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json().data)).not.toContain("must-not-escape");
  });

  test("redacts execution records persisted before the fix at list and detail read boundaries", async () => {
    const setup = await buildTestApplication(async () =>
      Response.json({ choices: [{ message: { content: "unused" } }] }),
    );
    await setup.repository.mutate((state) => {
      state.executions.run_legacy_secret = {
        id: "run_legacy_secret",
        workflowId: "wf_legacy",
        workflowName: "Legacy workflow",
        status: "DONE",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
        tokens: { input: 0, output: 0, total: 0 },
        costUsd: 0,
        startedBy: { id: setup.user.id, name: setup.user.name },
        stepOutputs: {
          legacy_step: { value: "visible", private_key: "must-not-escape" },
        },
        finalOutput: { value: "visible", password: "must-not-escape" },
      };
    });

    const detail = await setup.app.inject({
      method: "GET",
      url: "/api/executions/run_legacy_secret",
      headers: { authorization: `Bearer ${setup.token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.stepOutputs.legacy_step).toEqual({
      value: "visible",
    });
    expect(detail.json().data.finalOutput).toEqual({ value: "visible" });

    const list = await setup.app.inject({
      method: "GET",
      url: "/api/executions",
      headers: { authorization: `Bearer ${setup.token}` },
    });
    expect(list.statusCode).toBe(200);
    const legacy = list
      .json()
      .data.find((item: { id: string }) => item.id === "run_legacy_secret");
    expect(legacy.stepOutputs.legacy_step).toEqual({ value: "visible" });
    expect(legacy.finalOutput).toEqual({ value: "visible" });
    expect(JSON.stringify(list.json().data)).not.toContain("must-not-escape");
  });

  test("returns an ordered permission-scoped trace from one chat message through execution", async () => {
    const yaml = `name: Traced echo\ndescription: Executes a traced read-only tool.\ntrigger:\n  type: manual\nsteps:\n  - id: echo_value\n    action: demo.echo\n    parameters:\n      value: traced\n`;
    const setup = await buildTestApplication(
      async () =>
        Response.json({ choices: [{ message: { content: yaml } }] }),
      "tests/fixtures/tools.json",
      "tests/fixtures/rules.json",
      true,
    );
    setup.tools.register({
      name: "demo.echo",
      description: "Returns trace-test output.",
      async execute() {
        return { value: "visible", api_key: "must-not-escape" };
      },
    });
    const chat = await setup.app.inject({
      method: "POST",
      url: "/api/chat/sessions/chat_trace/messages",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { content: "Echo with a trace" },
    });
    expect(chat.statusCode).toBe(200);
    const traceId = chat.json().data.workflowDraft.traceId as string;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(chat.headers["x-trace-id"]).toBe(traceId);

    const deploy = await setup.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { authorization: `Bearer ${setup.token}` },
      payload: { candidate: chat.json().data.workflowDraft },
    });
    expect(deploy.statusCode).toBe(201);
    expect(deploy.json().data.traceId).toBe(traceId);
    const run = await setup.app.inject({
      method: "POST",
      url: `/api/workflows/${deploy.json().data.id}/run`,
      headers: { authorization: `Bearer ${setup.token}` },
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().data.traceId).toBe(traceId);

    const fullTrace = await setup.app.inject({
      method: "GET",
      url: `/api/executions?traceId=${encodeURIComponent(traceId)}`,
      headers: { authorization: `Bearer ${setup.token}` },
    });
    expect(fullTrace.statusCode).toBe(200);
    const chain = fullTrace.json().data as Array<{
      kind: string;
      timestamp: string;
      record: Record<string, unknown>;
    }>;
    const kinds = chain.map((entry) => entry.kind);
    expect(kinds).toContain("chat.message");
    expect(kinds).toContain("model.invocation");
    expect(kinds).toContain("governance.decision");
    expect(kinds).toContain("gate.validation");
    expect(kinds).toContain("execution");
    expect(kinds).toContain("execution.log");
    expect(kinds).toContain("execution.timeline");
    expect(chain.map((entry) => entry.timestamp)).toEqual(
      [...chain.map((entry) => entry.timestamp)].sort(),
    );
    expect(JSON.stringify(chain)).not.toContain("must-not-escape");

    const state = await setup.repository.snapshot();
    const invocation = Object.values(state.invocationProvenance).find(
      (record) => record.traceId === traceId,
    );
    expect(invocation).toMatchObject({
      sessionId: "chat_trace",
      messageId: chat.json().data.userMessage.id,
      candidateId: "candidate_1",
      actor: { id: setup.user.id, role: "Platform Admin" },
    });
    const governanceRecords = state.auditLogs.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).traceId === traceId &&
        (entry as Record<string, unknown>).source === "governance-gate-ts",
    ) as Array<Record<string, unknown>>;
    expect(governanceRecords.length).toBeGreaterThan(0);
    expect(governanceRecords[0]).toMatchObject({
      governanceRequestId: expect.any(String),
      actor: { id: setup.user.id, role: "Platform Admin" },
    });
    const dispatchAudit = state.auditLogs.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).traceId === traceId &&
        (entry as Record<string, unknown>).executionId === run.json().data.id,
    ) as Record<string, unknown> | undefined;
    expect(dispatchAudit).toMatchObject({
      workflowId: deploy.json().data.id,
      executionId: run.json().data.id,
    });
    for (const record of governanceRecords)
      expect(JSON.stringify(record.after)).not.toContain(traceId);
    expect(JSON.stringify(dispatchAudit?.after)).not.toContain(traceId);
    expect(setup.governanceRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(setup.governanceRequests)).not.toContain(traceId);

    await setup.repository.mutate((repositoryState) => {
      repositoryState.users[setup.user.id]!.roleId = "role_client";
    });
    const partialTrace = await setup.app.inject({
      method: "GET",
      url: `/api/executions?traceId=${encodeURIComponent(traceId)}`,
      headers: { authorization: `Bearer ${setup.token}` },
    });
    expect(partialTrace.statusCode).toBe(200);
    const partialKinds = partialTrace
      .json()
      .data.map((entry: { kind: string }) => entry.kind);
    expect(partialKinds).toContain("chat.message");
    expect(partialKinds).toContain("execution");
    expect(partialKinds).not.toContain("model.invocation");
    expect(partialKinds).not.toContain("governance.decision");
    expect(partialKinds).not.toContain("gate.validation");
  });

  test("production configuration refuses in-process mock ERP mode", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "production",
        MCP_MODE: "mock",
        JWT_SECRET: "production-secret-at-least-sixteen",
        PLATFORM_ADMIN_PASSWORD: "configured-password",
      }),
    ).toThrow("MCP_MODE=mock is refused in production");
  });
});

async function buildTestApplication(
  fetchImplementation: typeof fetch,
  toolPath = "tests/fixtures/tools.json",
  rulePath = "tests/fixtures/rules.json",
  withGovernance = false,
) {
  const config: AppConfig = {
    appName: "lcwe-test",
    environment: "test",
    port: 8081,
    apiBasePath: "/api",
    jwtSecret: "test-jwt-secret-at-least-sixteen-bytes",
    tokenTTLSeconds: 3600,
    allowPublicRegistration: false,
    toolRegistryPath: resolve(toolPath),
    ruleRegistryPath: resolve(rulePath),
    storageDriver: "memory",
    databaseURL: "",
    storageEncryptionKey: "",
    mcpBaseURL: "",
    mcpMode: "mock",
    mcpTransport: "bridge-v1",
    mcpTimeoutMs: 1_000,
    erpbridgeBaseURL: "",
    erpbridgeMcpToken: "",
    erpbridgeRoleMap: {},
    generationTimeoutMs: 1_000,
    governanceFallbackPolicyPath: "",
    governanceFallbackLlmApiKey: "",
    governanceFallbackLlmModel: "",
    governanceFallbackLlmTimeoutMs: 15_000,
    corsOrigins: ["http://localhost:5173"],
    platformAdminEmail: "admin@example.test",
    platformAdminPassword: "test-password",
  };
  const repository = new Repository(null);
  const user = await repository.mutate(async (state) => {
    const value = {
      id: "usr_test_admin",
      name: "Platform Admin",
      email: "admin@example.test",
      roleId: "role_admin",
      permissionOverrides: [],
      status: "Active",
      initials: "PA",
      departmentId: null,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    };
    state.users[value.id] = value;
    state.passwordHashes[value.id] = await hashPassword("test-password");
    return value;
  });
  const registries = await RegistryService.load(
    config.toolRegistryPath,
    config.ruleRegistryPath,
  );
  const validator = new RegistryValidator(registries, repository);
  const mcp = createGovernedMCPClient({
    baseURL: "",
    timeoutMs: 1_000,
    mode: "mock",
    validator,
  });
  const tools = new ToolRegistry();
  for (const tool of registries.snapshot().tools)
    tools.register(new GenericMCPTool(tool.name, tool.description, mcp));
  const executor = new Executor(tools, validator);
  const providers = new ProviderRuntime(
    repository,
    executor,
    fetchImplementation,
  );
  const providerConfiguration: RuntimeProviderConfiguration = {
    id: "provider_test",
    name: "Test",
    type: "openai_compatible",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: "test-key",
    model: "openai/gpt-4o-mini-2024-07-18",
    temperature: 0,
    timeoutMs: 1_000,
  };
  providers.activate(providerConfiguration);
  let validationGate: GovernedValidationGate | undefined;
  const governanceRequests: unknown[] = [];
  if (withGovernance) {
    const governance = new GovernanceService(
      new GovernanceAdapter({
        url: "https://governance.example.test/policy",
        apiKey: "governance-test-key",
        timeoutMs: 1_000,
        source: "primary",
        fetchImplementation: async (_url, init) => {
          governanceRequests.push(JSON.parse(String(init?.body)));
          return Response.json({
            policyVersion: "trace-test-v1",
            rules: [],
            evidenceIds: [],
          });
        },
      }),
      null,
      10_000,
      registries,
      repository,
    );
    await governance.initialize();
    validationGate = new GovernedValidationGate(
      governance,
      validator,
      registries,
      repository,
    );
  }
  const synthesis = new SynthesisService(
    providers,
    registries,
    validator,
    validationGate,
  );
  const app = await buildApp({
    config,
    repository,
    registries,
    validator,
    executor,
    providerRuntime: providers,
    synthesis,
    ...(validationGate === undefined ? {} : { validationGate }),
  });
  apps.push(app);
  await app.ready();
  const token = jwt.sign({}, config.jwtSecret, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: 3600,
  });
  return { app, repository, token, tools, user, config, governanceRequests };
}
