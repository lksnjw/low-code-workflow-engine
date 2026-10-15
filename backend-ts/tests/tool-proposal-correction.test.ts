import { expect, test, vi } from "vitest";
import { runQueryLoop } from "../src/agent/query-loop.js";
import { runActionLoop } from "../src/agent/action-loop.js";
import { queryChatPresentation } from "../src/agent/query-chat-presentation.js";
import { toolSchema } from "../src/registry/schemas.js";
import { normalizeToolArguments } from "../src/agent/workflow-runtime-validator.js";
import { ToolProposalCorrector } from "../src/agent/tool-proposal-correction.js";
import type { QueryToolCall, QueryTurnResult } from "../src/analysisprovider/query-types.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";

const input = { userMessage: "Look up the supplied recipient; do not send email", chatHistory: [], sessionId: "shape-test", actorId: "owner", actorRole: "Reader" };
const makeTool = (type: "string" | "array" = "string") => toolSchema.parse({ tool_id: "directory", name: "local.directory", mcp_tool_name: "directory_lookup",
  description: "Read recipient information only; never sends email", is_read_only: true, allowed_roles: ["Reader"],
  input_schema: { type: "object", properties: { recipients: type === "array" ? { type: "array", items: { type: "string" } } : { type: "string" } }, required: ["recipients"], additionalProperties: false } });
const call = (args: Record<string, unknown>, name = "directory_lookup"): QueryToolCall => ({ id: "proposal", name, arguments: args });
const turn = (calls: QueryToolCall[] = []): QueryTurnResult => ({ text: calls.length ? "" : "Confirmed directory result. No email was sent.", toolCalls: calls,
  stopReason: calls.length ? "tool_calls" : "stop", completionConfirmed: !calls.length, inputTokens: 10, outputTokens: 10, measured: true });

test.each(["query", "action"])("%s lets the model correct string/array proposals before exactly one real dispatch", async kind => {
  const provider = { queryWithTools: vi.fn().mockResolvedValueOnce(turn([call({ recipients: ["person@example.test"] })]))
    .mockResolvedValueOnce(turn([call({ recipients: "person@example.test" })])).mockResolvedValueOnce(turn()) };
  const dispatch = vi.fn(async () => ({ found: true }));
  const result = kind === "query" ? await runQueryLoop(input, [makeTool()], dispatch, provider) :
    await runActionLoop({ ...input, user: { id: "owner", role: "Reader" } as any }, [makeTool()], dispatch, vi.fn(), provider as unknown as ProviderRuntime);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("directory_lookup", { recipients: "person@example.test" });
  expect(provider.queryWithTools).toHaveBeenCalledTimes(3);
  const feedback = provider.queryWithTools.mock.calls[1]![0].filter((message: any) => message.role === "tool");
  expect(JSON.parse(feedback[0].content)).toMatchObject({ status: "NOT_DISPATCHED" });
  expect(feedback[0].content).toContain("expected string");
  expect(result.proposalCorrections).toEqual([{ toolName: "directory_lookup", reason: "ARGUMENT_SCHEMA", status: "NOT_DISPATCHED", correctionRequested: true }]);
  if (kind === "query") {
    expect((result as any).readOutcome).toBe("READS_COMPLETED");
    expect(queryChatPresentation("QUERY", input.userMessage, null, result as any).artifacts.proposalCorrections).toEqual(result.proposalCorrections);
  } else expect((result as any).blocked).toBe(false);
});

test("a schema-defined recipient array is preserved, including one-item arrays", async () => {
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn([call({ recipients: "person@example.test" })]))
    .mockResolvedValueOnce(turn([call({ recipients: ["person@example.test"] })])).mockResolvedValueOnce(turn());
  const dispatch = vi.fn(async () => ({ found: true }));
  const result = await runQueryLoop(input, [makeTool("array")], dispatch, { queryWithTools });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("directory_lookup", { recipients: ["person@example.test"] });
  expect(result.readOutcome).toBe("READS_COMPLETED");
});

test("wrong name must be explicitly reproposed using an offered exact contract; it is not silently renamed", async () => {
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn([call({ recipients: "person@example.test" }, "directory-lookup")]))
    .mockResolvedValueOnce(turn([call({ recipients: "person@example.test" })])).mockResolvedValueOnce(turn());
  const dispatch = vi.fn(async () => ({ found: true }));
  const result = await runQueryLoop(input, [makeTool()], dispatch, { queryWithTools });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("directory_lookup", { recipients: "person@example.test" });
  expect(result.proposalCorrections?.[0]?.reason).toBe("TOOL_NAME");
});

test("repeated malformed proposals stop boundedly, without dispatch or fabricated read evidence", async () => {
  const queryWithTools = vi.fn(async () => turn([call({ recipients: ["person@example.test"] })]));
  const dispatch = vi.fn();
  const result = await runQueryLoop(input, [makeTool()], dispatch, { queryWithTools });
  expect(queryWithTools).toHaveBeenCalledTimes(2); expect(dispatch).not.toHaveBeenCalled();
  expect(result.proposalCorrections?.at(-1)?.correctionRequested).toBe(false);
  expect(result.readOutcome).toBe("NO_CONFIRMED_READ");
});

test("a mixed invalid batch dispatches nothing until the entire corrected batch is validated", async () => {
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn([call({ recipients: "a@example.test" }), { ...call({ recipients: ["b@example.test"] }), id: "second" }]))
    .mockResolvedValueOnce(turn());
  const dispatch = vi.fn();
  await runQueryLoop(input, [makeTool()], dispatch, { queryWithTools });
  expect(dispatch).not.toHaveBeenCalled();
  expect(queryWithTools.mock.calls[1]![0].filter((message: any) => message.role === "tool")).toHaveLength(2);
});

test("missing selectors may become a qualified question, never an invented recipient or ERP result", async () => {
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn([call({})])).mockResolvedValueOnce({ ...turn(), text: JSON.stringify({ kind: "clarification", questions: ["Which recipient should I look up?"] }) });
  const dispatch = vi.fn();
  const result = await runQueryLoop(input, [makeTool()], dispatch, { queryWithTools });
  expect(dispatch).not.toHaveBeenCalled(); expect(result.clarification?.questions).toEqual(["Which recipient should I look up?"]);
});

test.each(["query", "action"])("%s never retries after entering the actual ERP dispatcher", async kind => {
  const provider = { queryWithTools: vi.fn(async () => turn([call({ recipients: "person@example.test" })])) };
  const dispatch = vi.fn(async () => { throw new Error("Unknown remote outcome"); });
  const result = kind === "query" ? await runQueryLoop(input, [makeTool()], dispatch, provider) :
    await runActionLoop({ ...input, user: { id: "owner", role: "Reader" } as any }, [makeTool()], dispatch, vi.fn(), provider as unknown as ProviderRuntime);
  expect(dispatch).toHaveBeenCalledTimes(1); expect(provider.queryWithTools).toHaveBeenCalledTimes(1);
  expect(result.proposalCorrections).toBeUndefined();
});

test("identity override is not a repairable input shape", async () => {
  const queryWithTools = vi.fn(async () => turn([call({ recipients: "person@example.test", role: "Admin" })]));
  const dispatch = vi.fn(); await runQueryLoop(input, [makeTool()], dispatch, { queryWithTools });
  expect(dispatch).not.toHaveBeenCalled(); expect(queryWithTools).toHaveBeenCalledTimes(1);
});

test.each(["drop recipient", "invent identifier", "add read"])("correction cannot silently change business values/scope: %s", async scenario => {
  const first = call({ recipients: ["a@example.test", "b@example.test"] });
  const next = scenario === "drop recipient" ? [call({ recipients: "a@example.test" })] : scenario === "invent identifier" ?
    [call({ recipients: "someone-else@example.test" })] : [call({ recipients: ["a@example.test", "b@example.test"] }), { ...call({ recipients: "a@example.test" }), id: "extra" }];
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn([first])).mockResolvedValueOnce(turn(next));
  const dispatch = vi.fn();
  const result = await runQueryLoop(input, [makeTool()], dispatch, { queryWithTools });
  expect(dispatch).not.toHaveBeenCalled(); expect(queryWithTools).toHaveBeenCalledTimes(2);
  expect(result.proposalCorrections?.at(-1)).toMatchObject({ reason: "SCOPE_CHANGE", correctionRequested: false });
});

test("an array can be correctly encoded as an ERP JSON-string argument without losing its values", async () => {
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn([call({ recipients: ["a@example.test", "b@example.test"] })]))
    .mockResolvedValueOnce(turn([call({ recipients: '["a@example.test","b@example.test"]' })])).mockResolvedValueOnce(turn());
  const dispatch = vi.fn(async () => ({ found: true }));
  await runQueryLoop(input, [makeTool()], dispatch, { queryWithTools });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("directory_lookup", { recipients: '["a@example.test","b@example.test"]' });
});

test("legacy normalization never unwraps genuine arrays or undeclared/unknown fields", () => {
  const values = { recipients: ["person@example.test"], unknown: ["unchanged"] };
  expect(normalizeToolArguments(values, makeTool("array")).args).toEqual(values);
  expect(normalizeToolArguments(values, undefined).args).toEqual(values);
  expect(normalizeToolArguments(values, makeTool()).args).toEqual({ recipients: "person@example.test", unknown: ["unchanged"] });
});

test("the final allowed model turn cannot bypass concrete-value preservation", () => {
  const corrector = new ToolProposalCorrector([makeTool()]);
  expect(corrector.feedback(turn([call({ recipients: ["a@example.test", "b@example.test"] })]))).toBeDefined();
  expect(corrector.feedback(turn([call({ recipients: "a@example.test" })]), false)).toBeUndefined();
  expect(corrector.blocked).toBe(true);
});
