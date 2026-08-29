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
      erpbridgeBaseURL: "",
      erpbridgeMcpToken: "",
      erpbridgeRoleMap: {},
      governanceFallbackPolicyPath: "",
      governanceFallbackLlmApiKey: "",
      governanceFallbackLlmModel: "",
      governanceFallbackLlmTimeoutMs: 15_000,
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

  test("registers exactly the 168 Go routes", () => {
    expect(routeTable).toHaveLength(168);
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

function materializePath(pattern: string): string {
  return pattern
    .replaceAll(":provider", "test")
    .replaceAll(":versionId", "missing-version")
    .replaceAll(":userId", "missing-user")
    .replaceAll(":id", "missing-id")
    .replace("*", "system-health");
}

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
