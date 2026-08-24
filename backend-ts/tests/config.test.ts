import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.js";

const erpbridgeEnvironment = {
  APP_ENV: "test",
  MCP_TRANSPORT: "erpbridge-mcp",
  ERPBRIDGE_BASE_URL: "https://erpbridge.example.test",
  ERPBRIDGE_MCP_TOKEN: "scoped-token",
  ERPBRIDGE_ROLE_MAP: JSON.stringify({
    "Workflow Builder": "workflow_builder",
    Client: "client",
  }),
};

describe("workflow transport configuration", () => {
  test("keeps the bridge-v1 transport as the default", () => {
    expect(loadConfig({}).mcpTransport).toBe("bridge-v1");
  });

  test("loads an authenticated ERPBridge transport and strict role map", () => {
    const config = loadConfig(erpbridgeEnvironment);

    expect(config).toMatchObject({
      mcpTransport: "erpbridge-mcp",
      erpbridgeBaseURL: "https://erpbridge.example.test",
      erpbridgeMcpToken: "scoped-token",
      erpbridgeRoleMap: {
        "Workflow Builder": "workflow_builder",
        Client: "client",
      },
    });
  });

  test("supports selecting the token from a named environment variable", () => {
    const config = loadConfig({
      ...erpbridgeEnvironment,
      ERPBRIDGE_MCP_TOKEN: "",
      ERPBRIDGE_MCP_TOKEN_ENV: "WORKFLOW_ERP_TOKEN",
      WORKFLOW_ERP_TOKEN: "selected-token",
    });

    expect(config.erpbridgeMcpToken).toBe("selected-token");
  });

  test("rejects an ambiguous direct token and token environment selector", () => {
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_MCP_TOKEN_ENV: "WORKFLOW_ERP_TOKEN",
        WORKFLOW_ERP_TOKEN: "selected-token",
      }),
    ).toThrow(/exactly one/);
  });

  test("requires an ERPBridge endpoint, token, and role map", () => {
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_BASE_URL: "" }),
    ).toThrow(/ERPBRIDGE_BASE_URL/);
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_MCP_TOKEN: "" }),
    ).toThrow(/ERPBRIDGE_MCP_TOKEN/);
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_ROLE_MAP: "{}" }),
    ).toThrow(/ERPBRIDGE_ROLE_MAP/);
  });

  test("requires HTTPS outside development", () => {
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_BASE_URL: "http://erpbridge.example.test",
      }),
    ).toThrow(/HTTPS/);
    expect(
      loadConfig({
        ...erpbridgeEnvironment,
        APP_ENV: "development",
        ERPBRIDGE_BASE_URL: "http://localhost:9090",
      }).erpbridgeBaseURL,
    ).toBe("http://localhost:9090");
  });

  test("rejects invalid transport and role-map entries", () => {
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, MCP_TRANSPORT: "unknown" }),
    ).toThrow(/MCP_TRANSPORT/);
    expect(() =>
      loadConfig({ ...erpbridgeEnvironment, ERPBRIDGE_ROLE_MAP: "not-json" }),
    ).toThrow(/JSON/);
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_ROLE_MAP: JSON.stringify({ Unknown: "unknown" }),
      }),
    ).toThrow(/unrecognized local role/);
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_ROLE_MAP: JSON.stringify({ Client: "" }),
      }),
    ).toThrow(/nonblank/);
    expect(() =>
      loadConfig({
        ...erpbridgeEnvironment,
        ERPBRIDGE_ROLE_MAP: JSON.stringify({
          Client: "same",
          "Workflow Builder": "same",
        }),
      }),
    ).toThrow(/duplicate/);
  });
});
