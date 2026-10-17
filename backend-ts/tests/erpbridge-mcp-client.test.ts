import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import type { DispatchIdentity } from "../src/tools/registry.js";
import {
  createErpbridgeMcpSession,
  consumeAcknowledgedReadError,
  ErpbridgeMcpToolError,
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

test("SDK-entry checkpoint precedes capability consumption, snapshots arguments and may deny without a call", async () => {
  const sdk = fakeSdk(), parameters = { value: "ok" }, identity = { ...builderIdentity }, f = await fixture(sdk, identity, parameters);
  await expect(f.session.clientFor(f.definition).execute("demo.echo", f.capability, parameters, identity, undefined, async () => { throw new Error("Checkpoint denied"); })).rejects.toThrow("Checkpoint denied");
  expect(sdk.callTool).not.toHaveBeenCalled();
  await f.session.clientFor(f.definition).execute("demo.echo", f.capability, parameters, identity, undefined, async () => { parameters.value = "mutated"; });
  expect(sdk.calls).toEqual([{ name: "erp.echo", args: { value: "ok", role: "workflow_builder" } }]);
});

test("mutating the originally minted identity during a checkpoint cannot inject a different remote role", async () => {
  const sdk = fakeSdk(), identity = { ...builderIdentity }, f = await fixture(sdk, identity);
  await expect(f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, identity, undefined, async () => { identity.erpbridgeRole = "mutated"; })).rejects.toThrow();
  expect(sdk.callTool).not.toHaveBeenCalled();
});

test("a synchronous SDK entry fence can deny after the awaited checkpoint without consuming authority", async () => {
  const sdk = fakeSdk(), f = await fixture(sdk), checkpoint = vi.fn(async () => {});
  await expect(f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity, undefined, checkpoint, () => { throw new Error("Connection changed"); })).rejects.toThrow("Connection changed");
  expect(checkpoint).toHaveBeenCalledOnce(); expect(sdk.callTool).not.toHaveBeenCalled();
  await f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity); expect(sdk.callTool).toHaveBeenCalledOnce();
});

test("session-wide storage guard denies direct discovery/policy and governed calls even without a broker hook", async () => {
  const sdk = fakeSdk(), f = await fixture(sdk);
  await f.validator.repository.close();
  await expect(f.session.listTools()).rejects.toThrow("closed"); await expect(f.session.callToolDirect("check_policy", {})).rejects.toThrow("closed");
  await expect(f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity)).rejects.toThrow("closed");
  expect(sdk.listTools).not.toHaveBeenCalled(); expect(sdk.callTool).not.toHaveBeenCalled();
});

test("repository close after an awaited SDK checkpoint denies session entry without relying on a caller guard", async () => {
  const sdk = fakeSdk(), f = await fixture(sdk);
  await expect(f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity, undefined, () => f.validator.repository.close())).rejects.toThrow("closed");
  expect(sdk.callTool).not.toHaveBeenCalled();
});

test("capability expiry is checked after checkpoint waits, not only before them", async () => {
  const sdk = fakeSdk(), f = await fixture(sdk); vi.useFakeTimers();
  await expect(f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity, undefined, async () => { vi.setSystemTime(Date.now() + 30_001); })).rejects.toThrow("expired");
  expect(sdk.callTool).not.toHaveBeenCalled();
});

test.each(["checkpoint", "admission"])("a hung %s wait is bounded, poisons reuse, and never enters the SDK", async stage => {
  const sdk = fakeSdk(), f = await fixture(sdk, builderIdentity, { value: "ok" }, 20); vi.useFakeTimers();
  let settle!: () => void; const hung = () => new Promise<void>(resolve => { settle = resolve; });
  const session = stage === "admission" ? await createErpbridgeMcpSession({ baseURL: "https://fixture.example.test", token: "fixture-only", timeoutMs: 20, validator: f.validator, sdkClient: sdk, admissionAuthorizer: hung }) : f.session;
  const promise = session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity, undefined, stage === "checkpoint" ? hung : undefined);
  const assertion = expect(promise).rejects.toMatchObject({ name: "OperationDeadlineExceeded" }); await vi.advanceTimersByTimeAsync(20); await assertion;
  expect(sdk.callTool).not.toHaveBeenCalled(); expect(session.available).toBe(false); settle(); await Promise.resolve(); await Promise.resolve(); expect(sdk.callTool).not.toHaveBeenCalled();
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
  timeoutMs = 1_000,
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
    timeoutMs,
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

afterEach(() => vi.useRealTimers());

test("acknowledged SDK read-error evidence is opaque, single-use and independent of public result mutation", async () => {
  const f = await fixture(fakeSdk({ content: [], isError: true }));
  const binding = Object.freeze({});
  const error = await f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity,
    undefined, undefined, undefined, undefined, binding).catch(error => error);
  expect(error).toBeInstanceOf(ErpbridgeMcpToolError); error.result.isError = false;
  expect(consumeAcknowledgedReadError(error, binding)).toMatchObject({ isError: true });
  expect(consumeAcknowledgedReadError(error, binding)).toBeUndefined();
  expect(consumeAcknowledgedReadError(new ErpbridgeMcpToolError({ content: [], isError: true }), binding)).toBeUndefined();
  await f.session.close();
});

test("another invocation identity cannot claim an acknowledged read response", async () => {
  const f = await fixture(fakeSdk({ content: [], isError: true }));
  const binding = Object.freeze({});
  const error = await f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity,
    undefined, undefined, undefined, undefined, binding).catch(error => error);
  expect(consumeAcknowledgedReadError(error, Object.freeze({}))).toBeUndefined();
  expect(consumeAcknowledgedReadError(error, binding)).toBeUndefined();
  await f.session.close();
});

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

  test("initialization timeout does not await hung cleanup and closes a late connection again", async () => {
    const ready = await fixture(fakeSdk());
    vi.useFakeTimers(); const sdk = fakeSdk();
    let complete!: () => void;
    vi.mocked(sdk.connect).mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    vi.mocked(sdk.close).mockImplementation(() => new Promise<void>(() => {}));
    const initialized = createErpbridgeMcpSession({ baseURL: "https://erpbridge.example.test", token: "fixture-only", timeoutMs: 1_000, validator: ready.validator, sdkClient: sdk });
    const assertion = expect(initialized).rejects.toMatchObject({ name: "OperationDeadlineExceeded" });
    await vi.advanceTimersByTimeAsync(1_000); await assertion;
    expect(sdk.connect).toHaveBeenCalledOnce(); expect(sdk.close).toHaveBeenCalledOnce();
    complete(); await Promise.resolve(); await Promise.resolve();
    expect(sdk.close).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["discovery", "direct", "governed"])("hung %s call fences session and never retries", async (operation) => {
    const sdk = fakeSdk(); const f = await fixture(sdk, builderIdentity, { value: "ok" }, 20);
    vi.useFakeTimers(); let complete!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { complete = resolve; });
    vi.mocked(sdk.callTool).mockImplementation(() => pending);
    vi.mocked(sdk.listTools).mockImplementation(() => pending as Promise<[]>);
    const result = operation === "discovery" ? f.session.listTools() : operation === "direct" ? f.session.callToolDirect("policy", {}) :
      f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity);
    const assertion = expect(result).rejects.toMatchObject({ name: "OperationDeadlineExceeded" });
    await vi.advanceTimersByTimeAsync(20); await assertion;
    expect(f.session.available).toBe(false); expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.callTool).toHaveBeenCalledTimes(operation === "discovery" ? 0 : 1);
    expect(sdk.listTools).toHaveBeenCalledTimes(operation === "discovery" ? 1 : 0);
    await expect(f.session.listTools()).rejects.toThrow(/closed/);
    await expect(f.session.callToolDirect("policy", {})).rejects.toThrow(/closed/);
    complete(operation === "discovery" ? [] : { content: [], structuredContent: { id: "late" } });
    await Promise.resolve(); await Promise.resolve();
    expect(f.session.available).toBe(false); expect(sdk.close).toHaveBeenCalledTimes(2);
  });

  test("in-flight abort rejects without claiming the SDK operation was cancelled", async () => {
    const sdk = fakeSdk(), f = await fixture(sdk); const controller = new AbortController();
    vi.mocked(sdk.callTool).mockImplementation(() => new Promise<unknown>(() => {}));
    const result = f.session.clientFor(f.definition).execute("demo.echo", f.capability, f.parameters, f.identity, controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sdk.callTool).toHaveBeenCalledOnce());
    controller.abort(); await assertion;
    expect(f.session.available).toBe(false); expect(sdk.callTool).toHaveBeenCalledOnce();
  });

  test("pre-aborted governed call does not consume capability or poison the session", async () => {
    const sdk = fakeSdk(), f = await fixture(sdk); const controller = new AbortController(); controller.abort();
    const client = f.session.clientFor(f.definition);
    await expect(client.execute("demo.echo", f.capability, f.parameters, f.identity, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.session.available).toBe(true); expect(sdk.callTool).not.toHaveBeenCalled();
    await expect(client.execute("demo.echo", f.capability, f.parameters, f.identity)).resolves.toBeDefined();
  });

  test("close bounds cleanup, is idempotent and abandons in-flight wait", async () => {
    const sdk = fakeSdk(), f = await fixture(sdk, builderIdentity, { value: "ok" }, 20);
    vi.useFakeTimers(); vi.mocked(sdk.close).mockImplementation(() => new Promise<void>(() => {}));
    vi.mocked(sdk.callTool).mockImplementation(() => new Promise<unknown>(() => {}));
    const waiting = f.session.callToolDirect("policy", {});
    const waitingAssertion = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    const closing = f.session.close(); expect(f.session.close()).toBe(closing);
    const closeAssertion = expect(closing).rejects.toMatchObject({ name: "OperationDeadlineExceeded" });
    await waitingAssertion; await vi.advanceTimersByTimeAsync(20); await closeAssertion;
    expect(sdk.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
