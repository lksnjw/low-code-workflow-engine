import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import type { DispatchIdentity } from "../src/tools/registry.js";
import {
  createErpbridgeMcpSession,
  type ErpbridgeMcpSdkClient,
} from "../src/tools/erpbridge-mcp-client.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import type { ToolDefinition } from "../src/registry/schemas.js";

const workflowYAML = `name: adapter_test
description: Verify the governed ERPBridge adapter.
trigger:
  type: manual
steps:
  - id: echo
    action: demo.echo
    parameters:
      value: ok
`;

const builderIdentity: DispatchIdentity = Object.freeze({
  userId: "usr_builder",
  localRole: "Workflow Builder",
  erpbridgeRole: "workflow_builder",
});

/*******************************************************************************
 * Function: fakeSdk
 *
 * Creates a mock ERPBridge MCP SDK client for transport tests.
 ******************************************************************************/
function fakeSdk(
  result: unknown = { content: [{ type: "text", text: "ok" }] },
): ErpbridgeMcpSdkClient & {
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return result;
    }),
  };
}

/*******************************************************************************
 * Function: fixture
 *
 * Creates a governed ERPBridge client with the supplied test options.
 ******************************************************************************/
async function fixture(
  sdk: ErpbridgeMcpSdkClient,
  identity: DispatchIdentity = builderIdentity,
  parameters: Record<string, unknown> = { value: "ok" },
) {
  const registries = await RegistryService.load(
    resolve("tests/fixtures/tools.json"),
    resolve("tests/fixtures/rules.json"),
  );
  const validator = new RegistryValidator(registries, new Repository());
  const { token, result } = await validator.validateAndIssueToken(
    "test",
    workflowYAML,
    "Workflow Builder",
  );
  expect(result.passed).toBe(true);
  const evaluated = await validator.evaluateResolvedStep(
    "dispatch.test",
    workflowYAML,
    0,
    parameters,
    token,
    identity,
  );
  expect(evaluated.capability).not.toBeNull();
  const session = await createErpbridgeMcpSession({
    baseURL: "https://erpbridge.example.test",
    token: "scoped-token",
    timeoutMs: 1_000,
    validator,
    sdkClient: sdk,
  });
  const definition = {
    ...registries.snapshot().tools[0]!,
    mcp_tool_name: "erp.echo",
    allowed_roles: ["Workflow Builder"],
  };
  return {
    session,
    validator,
    capability: evaluated.capability!,
    definition,
    identity,
    parameters,
  };
}

describe("governed ERPBridge MCP adapter", () => {
  test("connects once and calls the reviewed remote MCP name with the mapped role", async () => {
    const sdk = fakeSdk();
    const testFixture = await fixture(sdk);
    const client = testFixture.session.clientFor(testFixture.definition);

    const result = await client.execute(
      "demo.echo",
      testFixture.capability,
      { value: "ok" },
      testFixture.identity,
    );

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.callTool).toHaveBeenCalledOnce();
    expect(sdk.calls).toEqual([
      { name: "erp.echo", args: { value: "ok", role: "workflow_builder" } },
    ]);
  });

  test("rejects forged, mutated, reused, and expired capabilities before SDK calls", async () => {
    const sdk = fakeSdk();
    const testFixture = await fixture(sdk);
    const client = testFixture.session.clientFor(testFixture.definition);

    await expect(
      client.execute(
        "demo.echo",
        Object.freeze({}),
        { value: "ok" },
        testFixture.identity,
      ),
    ).rejects.toThrow(/not minted/);
    await expect(
      client.execute(
        "demo.echo",
        testFixture.capability,
        { value: "changed" },
        testFixture.identity,
      ),
    ).rejects.toThrow(/parameter hash mismatch/);
    await client.execute(
      "demo.echo",
      testFixture.capability,
      testFixture.parameters,
      testFixture.identity,
    );
    await expect(
      client.execute(
        "demo.echo",
        testFixture.capability,
        testFixture.parameters,
        testFixture.identity,
      ),
    ).rejects.toThrow(/consumed/);
    expect(sdk.callTool).toHaveBeenCalledOnce();

    const expiredSdk = fakeSdk();
    const expiredFixture = await fixture(expiredSdk);
    const expiredValidator = new RegistryValidator(
      expiredFixture.validator.registries,
      new Repository(),
      -1,
    );
    const expired = await expiredValidator.validateAndIssueToken(
      "test",
      workflowYAML,
      "Workflow Builder",
    );
    const expiredCapability = await expiredValidator.evaluateResolvedStep(
      "dispatch.test",
      workflowYAML,
      0,
      { value: "ok" },
      expired.token,
      expiredFixture.identity,
    );
    const expiredSession = await createErpbridgeMcpSession({
      baseURL: "https://erpbridge.example.test",
      token: "scoped-token",
      timeoutMs: 1_000,
      validator: expiredValidator,
      sdkClient: expiredSdk,
    });
    await expect(
      expiredSession
        .clientFor(expiredFixture.definition)
        .execute(
          "demo.echo",
          expiredCapability.capability!,
          { value: "ok" },
          expiredFixture.identity,
        ),
    ).rejects.toThrow(/expired/);
    expect(expiredSdk.callTool).not.toHaveBeenCalled();
  });

  test("falls back to the local action when mcp_tool_name is blank", async () => {
    const sdk = fakeSdk();
    const testFixture = await fixture(sdk);
    const client = testFixture.session.clientFor({
      ...testFixture.definition,
      mcp_tool_name: "",
    });

    await client.execute(
      "demo.echo",
      testFixture.capability,
      { value: "ok" },
      testFixture.identity,
    );

    expect(sdk.calls[0]?.name).toBe("demo.echo");
  });

  test("rejects a workflow-provided role before the SDK call", async () => {
    const sdk = fakeSdk();
    const testFixture = await fixture(sdk, builderIdentity, {
      value: "ok",
      role: "attacker",
    });
    const client = testFixture.session.clientFor(testFixture.definition);

    await expect(
      client.execute(
        "demo.echo",
        testFixture.capability,
        testFixture.parameters,
        testFixture.identity,
      ),
    ).rejects.toThrow(/role/);
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  test("rejects a guarded call without a mapped ERPBridge role", async () => {
    const sdk = fakeSdk();
    const identity = Object.freeze({
      userId: "usr_builder",
      localRole: "Workflow Builder",
      erpbridgeRole: null,
    });
    const testFixture = await fixture(sdk, identity);
    const client = testFixture.session.clientFor(testFixture.definition);

    await expect(
      client.execute(
        "demo.echo",
        testFixture.capability,
        { value: "ok" },
        identity,
      ),
    ).rejects.toThrow(/mapped ERPBridge role/);
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  test("fails MCP tool errors without exposing a successful result", async () => {
    const sdk = fakeSdk({
      isError: true,
      content: [{ type: "text", text: "ERP rejected the request" }],
    });
    const testFixture = await fixture(sdk);
    const client = testFixture.session.clientFor(testFixture.definition);

    await expect(
      client.execute(
        "demo.echo",
        testFixture.capability,
        { value: "ok" },
        testFixture.identity,
      ),
    ).rejects.toThrow(/MCP tool failed/);
    expect(sdk.callTool).toHaveBeenCalledOnce();
  });

  test("does not issue a second SDK call after an ambiguous transport failure", async () => {
    const sdk = fakeSdk();
    vi.mocked(sdk.callTool).mockRejectedValueOnce(new Error("connection lost"));
    const testFixture = await fixture(sdk);
    const client = testFixture.session.clientFor(testFixture.definition);

    await expect(
      client.execute(
        "demo.echo",
        testFixture.capability,
        { value: "ok" },
        testFixture.identity,
      ),
    ).rejects.toThrow("connection lost");
    expect(sdk.callTool).toHaveBeenCalledOnce();
  });

  test("closes the private SDK session", async () => {
    const sdk = fakeSdk();
    const testFixture = await fixture(sdk);

    await testFixture.session.close();

    expect(sdk.close).toHaveBeenCalledOnce();
  });
});
