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
    expect(Object.values(state.invocationProvenance)).toHaveLength(1);
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
  const synthesis = new SynthesisService(providers, registries, validator);
  const app = await buildApp({
    config,
    repository,
    registries,
    validator,
    executor,
    providerRuntime: providers,
    synthesis,
  });
  apps.push(app);
  await app.ready();
  const token = jwt.sign({}, config.jwtSecret, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: 3600,
  });
  return { app, repository, token };
}
