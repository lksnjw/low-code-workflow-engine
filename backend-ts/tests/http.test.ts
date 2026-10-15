import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hashPassword } from "../src/authn/password.js";
import type { AppConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { routeTable } from "../src/http/generated-routes.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { Executor } from "../src/runner/executor.js";
import { GenericMCPTool } from "../src/tools/generic-mcp-tool.js";
import { createGovernedMCPClient } from "../src/tools/mcp-client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

type WireFixture = {
  routes: {
    method: string;
    pattern: string;
    scenarios: {
      id: string;
      request: { path: string; method: string; body?: string };
      status: number;
      body: string;
    }[];
  }[];
};

describe("complete HTTP route graph", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let accessToken = "";

  beforeAll(async () => {
    const config: AppConfig = {
      appName: "lcwe-test",
      environment: "test",
      port: 8081,
      apiBasePath: "/api",
      jwtSecret: "test-jwt-secret-at-least-sixteen-bytes",
      tokenTTLSeconds: 3600,
      allowPublicRegistration: false,
      toolRegistryPath: resolve("tests/fixtures/tools.json"),
      ruleRegistryPath: resolve("tests/fixtures/rules.json"),
      storageDriver: "memory",
      databaseURL: "",
      storageEncryptionKey: "",
      mcpBaseURL: "",
      mcpMode: "mock",
      mcpTransport: "bridge-v1",
      mcpTimeoutMs: 1000,
      readWorkerConcurrency: 2,
      readWorkerPerActor: 1,
      readWorkerLeaseMs: 30_000,
      erpbridgeBaseURL: "",
      erpbridgeMcpToken: "",
      erpbridgeMcpTokenReference: "",
      erpbridgeRoleMap: {},
      erpbridgeConnections: [],
      erpbridgePrimaryConnectionId: "erpbridge-default",
      governanceFallbackPolicyPath: "",
      governanceFallbackLlmApiKey: "",
      governanceFallbackLlmModel: "",
      governanceFallbackLlmTimeoutMs: 15_000,
      policyGateTimeoutMs: 10_000,
      corsOrigins: ["http://localhost:5173"],
      platformAdminEmail: "admin@example.test",
      platformAdminPassword: "test-password",
    };
    const repository = new Repository(null);
    const passwordHash = await hashPassword("test-password");
    const admin = await repository.mutate((state) => {
      const user = {
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
      state.users[user.id] = user;
      state.passwordHashes[user.id] = passwordHash;
      return user;
    });
    accessToken = jwt.sign({}, config.jwtSecret, {
      algorithm: "HS256",
      subject: admin.id,
      expiresIn: 3600,
    });
    const registries = await RegistryService.load(
      config.toolRegistryPath,
      config.ruleRegistryPath,
    );
    const validator = new RegistryValidator(registries, repository);
    const mcp = createGovernedMCPClient({
      baseURL: "",
      timeoutMs: 1000,
      mode: "mock",
      validator,
    });
    const tools = new ToolRegistry();
    for (const tool of registries.snapshot().tools)
      tools.register(new GenericMCPTool(tool.name, tool.description, mcp));
    const executor = new Executor(tools, validator);
    app = await buildApp({
      config,
      repository,
      registries,
      validator,
      executor,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("preserves every frozen Go route plus only named product extensions", async () => {
    const fixture = (await import("../fixtures/parity/http/route-wire-capture.json", { with: { type: "json" } })).default as WireFixture;
    const captured = fixture.routes.map((route) => `${route.method} ${route.pattern}`);
    expect(captured).toHaveLength(168);
    const actual = routeTable.map((route) => `${route.method} ${route.path}`);
    expect(new Set(actual).size).toBe(actual.length);
    expect(captured.filter((route) => !actual.includes(route))).toEqual([]);
    expect(actual.filter((route) => !captured.includes(route)).sort()).toEqual([
      "GET /api/dashboard/tasks",
      "GET /api/chat/sessions/:id/erp-actions/:actionId", "POST /api/chat/sessions/:id/erp-actions/:actionId",
      "GET /api/workflows/:id/run-receipts/:key",
      "POST /api/executions/:id/approve", "POST /api/executions/:id/reject", "POST /api/executions/:id/reconcile",
      "GET /api/executions/:id/report-page-resolutions", "POST /api/executions/:id/report-page-resolutions",
      "GET /api/executions/:id/readbacks", "POST /api/executions/:id/readbacks", "POST /api/executions/:id/readbacks/:queryId/cancel",
      "GET /api/executions/:id/recovery-artifacts", "POST /api/executions/:id/recovery-artifacts",
      "POST /api/executions/:id/recovery-artifacts/:artifactId/admit",
      "POST /api/workflows/:id/approve-generation", "POST /api/workflows/:id/reject-generation",
      "POST /api/workflows/:id/commands", "POST /api/workflows/:id/node-proposals", "GET /api/workflows/:id/readiness",
      "GET /api/workflows/:id/schedule", "PUT /api/workflows/:id/schedule",
      "GET /api/executions/:id/events",
      "GET /api/execution-reviews",
      "GET /api/settings/runtime-approval-policy",
      "GET /api/settings/rag-policy", "POST /api/settings/rag-policy/test", "POST /api/settings/rag-policy/documents",
      "GET /api/chat/models",
      "GET /api/chat/capabilities",
      "GET /api/pipeline/v1/health/ready", "GET /api/pipeline/v1/jobs/:id",
      "POST /api/pipeline/v1/files/csv", "POST /api/pipeline/v1/files/documents",
      "GET /api/pipeline/v1/library/catalog", "POST /api/pipeline/v1/library/catalog", "GET /api/pipeline/v1/library/inventory",
      "POST /api/pipeline/v1/library/search", "POST /api/pipeline/v1/library/resolve",
      "POST /api/pipeline/v1/library/migrate",
      "POST /api/pipeline/v1/library/delegation",
      "GET /api/chat/sessions/:id/attachments", "POST /api/chat/sessions/:id/attachments", "GET /api/chat/sessions/:id/attachments/:uploadId",
      "POST /api/chat/sessions/:id/attachments/preview",
      "POST /api/chat/sessions/:id/attachments/prepare",
      "POST /api/chat/sessions/:id/attachments/:uploadId/analyse", "POST /api/chat/sessions/:id/attachments/:uploadId/confirm", "POST /api/chat/sessions/:id/attachments/:uploadId/recover",
      "GET /api/registry/capabilities", "POST /api/registry/capabilities/discovery", "POST /api/registry/capabilities/import", "POST /api/registry/capabilities/:id/review", "POST /api/registry/capabilities/:id/disable",
      "GET /api/settings/mcp-connections", "POST /api/settings/mcp-connections/:id/connect", "POST /api/settings/mcp-connections/:id/disconnect", "POST /api/settings/mcp-connections/:id/test",
      "GET /api/profile/erp-connections", "PUT /api/profile/erp-connections/:id", "DELETE /api/profile/erp-connections/:id", "POST /api/profile/erp-connections/:id/test",
      "GET /api/chat/sessions/:id/operations", "GET /api/chat/operations/:id", "POST /api/chat/operations/:id/cancel",
    ].sort());
  });

  test("matches every captured missing-auth response", async () => {
    const fixture = (
      await import("../fixtures/parity/http/route-wire-capture.json", {
        with: { type: "json" },
      })
    ).default as WireFixture;
    const cases = fixture.routes.flatMap((route) =>
      route.scenarios
        .filter(
          (scenario) =>
            scenario.id === "unauthenticated-default" &&
            scenario.status === 401,
        )
        .map((scenario) => ({ route, scenario })),
    );
    expect(cases.length).toBeGreaterThan(100);
    for (const { route, scenario } of cases) {
      if (route.pattern === "/ws/*") continue;
      const response = await app.inject({
        method: route.method as "GET",
        url: materializePath(route.pattern),
      });
      expect(response.statusCode, `${route.method} ${route.pattern}`).toBe(401);
      expect(response.body, `${route.method} ${route.pattern}`).toBe(
        scenario.body,
      );
    }
  });

  test("matches captured statuses/messages and contains no unported placeholder", async () => {
    const fixture = (
      await import("../fixtures/parity/http/route-wire-capture.json", {
        with: { type: "json" },
      })
    ).default as WireFixture;
    const cases = fixture.routes.flatMap((route) =>
      route.scenarios
        .filter(
          (scenario) =>
            scenario.id === "authenticated-default" ||
            scenario.id === "authenticated-malformed-json",
        )
        .map((scenario) => ({ route, scenario })),
    );
    const deviations: Record<string, unknown>[] = [];
    for (const { route, scenario } of cases) {
      if (route.pattern === "/ws/*") continue;
      const response = await app.inject({
        method: route.method as "GET",
        url: scenario.request.path,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(scenario.request.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(scenario.request.body === undefined
          ? {}
          : { payload: scenario.request.body }),
      });
      expect(response.body, `${route.method} ${route.pattern}`).not.toContain(
        "not yet been ported",
      );
      const expectedBody = parseJSON(scenario.body);
      const actualBody = parseJSON(response.body);
      const expectedMessage = isRecord(expectedBody)
        ? expectedBody.message
        : undefined;
      const actualMessage = isRecord(actualBody)
        ? actualBody.message
        : undefined;
      // Named product change: cancellation now has a persisted safe boundary.
      // Keep the frozen wire fixture intact and assert this exact exception,
      // rather than rebaselining unrelated captures/verdicts.
      if (route.method === "POST" && route.pattern === "/api/executions/:id/cancel") {
        expect(scenario.status).toBe(501);
        expect(expectedMessage).toBe("Cancellation is unavailable while executions run synchronously");
        expect(response.statusCode).toBe(scenario.id === "authenticated-malformed-json" ? 400 : 404);
        expect(actualMessage).toBe(scenario.id === "authenticated-malformed-json" ? "Cancellation accepts an empty body" : "Execution not found");
        continue;
      }
      // Named product change: the canvas endpoint now accepts a versioned
      // semantic node/edge graph. Empty input fails the new graph contract;
      // the frozen Go capture remains historical evidence of the old stub.
      if (route.method === "POST" && route.pattern === "/api/canvas/validate-workflow" && scenario.id === "authenticated-default") {
        expect(scenario.status).toBe(422);
        expect(expectedMessage).toBe("Canvas node/edge to YAML conversion is not implemented yet. Provide yaml for validation.");
        expect(response.statusCode).toBe(422);
        expect(actualMessage).toBe("Canvas graph cannot be converted without changing its meaning");
        expect(isRecord(actualBody) && isRecord(actualBody.meta) ? actualBody.meta.code : null).toBe("CANVAS_GRAPH_INVALID");
        continue;
      }
      if (
        response.statusCode !== scenario.status ||
        actualMessage !== expectedMessage
      )
        deviations.push({
          route: `${route.method} ${route.pattern}`,
          scenario: scenario.id,
          expected: { status: scenario.status, message: expectedMessage },
          actual: { status: response.statusCode, message: actualMessage },
        });
    }
    if (deviations.length > 0) {
      throw new Error(
        `${deviations.length} HTTP status/message deviations:\n${JSON.stringify(deviations.slice(0, 30), null, 2)}`,
      );
    }
  }, 30_000);
});

/*******************************************************************************
 * Function: materializePath
 *
 * Replaces route parameters with concrete values for HTTP tests.
 ******************************************************************************/
function materializePath(pattern: string): string {
  return pattern
    .replaceAll(":provider", "test")
    .replaceAll(":versionId", "missing-version")
    .replaceAll(":userId", "missing-user")
    .replaceAll(":id", "missing-id")
    .replace("*", "system-health");
}

/*******************************************************************************
 * Function: parseJSON
 *
 * Parses a test response as JSON when possible.
 ******************************************************************************/
function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
/*******************************************************************************
 * Function: isRecord
 *
 * Checks whether a value is a non-null object other than an array.
 ******************************************************************************/
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
