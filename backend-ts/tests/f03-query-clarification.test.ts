import { expect, test, vi } from "vitest";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import { runQueryLoop } from "../src/agent/query-loop.js";
import { queryChatPresentation } from "../src/agent/query-chat-presentation.js";
import { toolSchema } from "../src/registry/schemas.js";

test.each([undefined, "prompt/query/v3", "prompt/runtime-agent/v1", "prompt/query/v4", "prompt/query/v5", "prompt/query/v6"])(
  "F03 actual client adds clarification evidence only to the versioned interactive contract (%s)", async promptTemplateVersion => {
    for (const finishReason of ["stop", "length", undefined, "tool_calls"]) {
      const transport = vi.fn<typeof fetch>(async () => Response.json({ choices: [{
        ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
        message: { content: "Which customer?", ...(finishReason === "tool_calls" ? { tool_calls: [{
          id: "read", type: "function", function: { name: "invoice.list", arguments: "{}" },
        }] } : {}) },
      }], usage: { prompt_tokens: 9, completion_tokens: 8 } }));
      const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", fetchImplementation: transport });
      const turn = await client.queryWithTools([{ role: "user", content: "fixture" }], [], {
        ...(promptTemplateVersion === undefined ? {} : { promptTemplateVersion }),
      });
      if (["prompt/query/v4", "prompt/query/v5", "prompt/query/v6"].includes(promptTemplateVersion ?? "")) expect(turn.completionConfirmed).toBe(finishReason === "stop");
      else {
        expect(turn).not.toHaveProperty("completionConfirmed");
        expect(JSON.parse(JSON.stringify(turn))).not.toHaveProperty("completionConfirmed");
      }
      expect(turn.stopReason).toBe(finishReason ?? "stop");
      expect(transport).toHaveBeenCalledOnce();
    }
  },
);

// Actual client/loop/presentation; substitute only the provider's raw HTTP I/O.
test.each(["clarification", "unsupported-completion"] as const)("F03 actual model no-read turn preserves only a qualified clarification (%s)", async scenario => {
  const question = "Which customer and date range should I use?";
  const content = scenario === "clarification" ? JSON.stringify({ kind: "clarification", questions: [question] }) : "I sent the invoice report to the manager.";
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    expect(wire.model).toBe("model-b");
    expect(wire.messages[0].content).toContain("prompt/query/v6");
    expect(wire).not.toHaveProperty("response_format");
    expect(JSON.parse(wire.messages.at(-1).content).USER_REQUEST).toBe("Get the invoices for a customer");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 8 } });
  });
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", temperature: 0, timeoutMs: 1000, fetchImplementation: transport });
  const tool = vi.fn(async () => { throw new Error("This clarification must never dispatch a tool"); });
  const result = await runQueryLoop({ userMessage: "Get the invoices for a customer", chatHistory: [], sessionId: "f03-chat", actorId: "owner", actorRole: "Platform Admin" }, [], tool, client);
  const presentation = queryChatPresentation("QUERY", "Get the invoices for a customer", null, result);
  expect(tool).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledOnce();
  expect(result.readOutcome).toBe("NO_CONFIRMED_READ"); expect(result.toolSteps).toEqual([]); expect(result.toolCallLog).toEqual([]);
  expect(presentation.workflowDraft).toBeUndefined(); expect(presentation.artifacts).not.toHaveProperty("workflowId"); expect(result.visualisation).toBeUndefined();
  if (scenario === "clarification") {
    expect(result.text, "The selected model's missing-input question must survive without becoming ERP evidence").toBe(question);
    expect(result.narrativeRejected).toBe(false);
    expect(result.clarification).toEqual({ kind: "clarification", questions: [question] }); expect(presentation.artifacts.clarification).toEqual(result.clarification);
  } else {
    expect(result.text).toBe("No confirmed ERP data was retrieved. No email was sent, schedule activated or ERP change made.");
    expect(result.narrativeRejected).toBe(true);
  }
});

const queryInput = { userMessage: "Get the invoices for a customer", chatHistory: [], sessionId: "f03-chat", actorId: "owner", actorRole: "Reader" };
const read = toolSchema.parse({ tool_id: "f03-read", name: "invoice.list", mcp_tool_name: "invoice.list", description: "List invoices",
  is_read_only: true, allowed_roles: ["Reader"], input_schema: { type: "object", properties: {}, additionalProperties: false } });

async function runActualChoice(content: string, choice: Record<string, unknown> = { finish_reason: "stop" }, options: { signal?: AbortSignal; calls?: readonly Record<string, unknown>[]; dispatch?: () => Promise<unknown>; completionTokens?: number; beforeResponse?: () => void } = {}) {
  const transport = vi.fn<typeof fetch>(async () => { options.beforeResponse?.(); return Response.json({ choices: [{ ...choice, message: { content,
    ...(options.calls ? { tool_calls: options.calls } : {}) } }], usage: { prompt_tokens: 9, completion_tokens: options.completionTokens ?? 8 } }); });
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", timeoutMs: 1000, fetchImplementation: transport });
  const dispatch = vi.fn(options.dispatch ?? (async () => ({ invoice: "confirmed" })));
  const result = await runQueryLoop({ ...queryInput, ...(options.signal ? { signal: options.signal } : {}) }, [read], dispatch, client);
  return { result, transport, dispatch };
}

test.each([
  ["one question", { kind: "clarification", questions: ["Which customer should I use?"] }, "Which customer should I use?"],
  ["three questions", { kind: "clarification", questions: ["Which customer?", "What date range?", "Which currency?"] }, "Which customer?\nWhat date range?\nWhich currency?"],
] as const)("F03 accepts strict clarification shape: %s", async (_label, value, expected) => {
  const { result, dispatch, transport } = await runActualChoice(JSON.stringify(value));
  expect(result).toMatchObject({ text: expected, clarification: { kind: "clarification" }, narrativeRejected: false, boundHit: false, stopReason: "COMPLETED", readOutcome: "NO_CONFIRMED_READ" });
  expect(result.toolCallLog).toEqual([]); expect(result.toolSteps).toEqual([]); expect(result.visualisation).toBeUndefined();
  const presentation = queryChatPresentation("QUERY", queryInput.userMessage, null, result);
  expect(presentation.workflowDraft).toBeUndefined(); expect(presentation.artifacts.clarification).toEqual(result.clarification);
  expect(dispatch).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledOnce();
});

test.each([
  ["empty", { kind: "clarification", questions: [] }],
  ["too many", { kind: "clarification", questions: ["First?", "Second?", "Third?", "Fourth?"] }],
  ["nonstring", { kind: "clarification", questions: [42] }],
  ["untrimmed", { kind: "clarification", questions: [" Which customer? "] }],
  ["invalid JSON", '{"kind":"clarification","questions":["Which customer?",]}' ],
  ["overlong", { kind: "clarification", questions: ["x".repeat(241) + "?"] }],
  ["unknown key", { kind: "clarification", questions: ["Which customer?"], authority: "approved" }],
  ["fenced", "```json\n{\"kind\":\"clarification\",\"questions\":[\"Which customer?\"]}\n```"],
  ["plain prose", "Which customer should I use?"],
  ["fabricated ERP fact", { kind: "clarification", questions: ["The invoice total is 20 USD; which customer?"] }],
  ["unsupported effect claim", { kind: "clarification", questions: ["I sent the report; which date range?"] }],
  ["permission question", { kind: "clarification", questions: ["May I email the report?"] }],
  ["mixed completion claims", { kind: "clarification", questions: ["No email was sent, but the report was delivered. Which period?"] }],
  ["embedded visualisation", { kind: "clarification", questions: ["<vis>{\"type\":\"bar\",\"title\":\"fabricated\",\"data\":[]}</vis> Which customer?"] }],
] as const)("F03 rejects malformed or non-question clarification: %s", async (_label, value) => {
  const { result, transport, dispatch } = await runActualChoice(typeof value === "string" ? value : JSON.stringify(value));
  expect(result.clarification).toBeUndefined(); expect(result.narrativeRejected).toBe(true);
  expect(result.readOutcome).toBe("NO_CONFIRMED_READ"); expect(result.text).toContain("No confirmed ERP data");
  expect(transport).toHaveBeenCalledOnce(); expect(dispatch).not.toHaveBeenCalled();
});

test.each([
  ["missing finish reason", {}, [] as Record<string, unknown>[]],
  ["length", { finish_reason: "length" }, [] as Record<string, unknown>[]],
  ["content filter", { finish_reason: "content_filter" }, [] as Record<string, unknown>[]],
  ["stop with tool call", { finish_reason: "stop" }, [{ id: "read", type: "function", function: { name: "invoice.list", arguments: "{}" } }]],
] as const)("F03 requires explicit completed no-tool provider evidence: %s", async (_label, choice, calls) => {
  const { result, transport } = await runActualChoice(JSON.stringify({ kind: "clarification", questions: ["Which customer?"] }), choice, { calls });
  expect(result.clarification).toBeUndefined(); expect(result.narrativeRejected).toBe(true);
  expect(result.readOutcome).toBe("NO_CONFIRMED_READ"); expect(transport).toHaveBeenCalledOnce();
});

test("F03 never presents a question when the pre-turn binding check fails", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ kind: "clarification", questions: ["Which customer?"] }) } }] }));
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", fetchImplementation: transport });
  const result = await runQueryLoop({ ...queryInput, onTurn: async () => { throw new Error("binding changed"); } }, [read], async () => ({ invoice: "unreachable" }), client);
  expect(result).toMatchObject({ stopReason: "PROVIDER_FAILED", readOutcome: "NO_CONFIRMED_READ", narrativeRejected: true });
  expect(result.clarification).toBeUndefined(); expect(transport).not.toHaveBeenCalled();
});

test("F03 does not treat a post-read clarification as a successful clarification", async () => {
  const content = JSON.stringify({ kind: "clarification", questions: ["Which customer?"] });
  const sequence: unknown[] = [
    { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "read", type: "function", function: { name: "invoice.list", arguments: "{}" } }] } }] },
    { choices: [{ finish_reason: "stop", message: { content } }] },
  ];
  const transport = vi.fn<typeof fetch>(async () => Response.json(sequence.shift()));
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", timeoutMs: 1000, fetchImplementation: transport });
  const result = await runQueryLoop(queryInput, [read], async () => ({ invoice: "confirmed" }), client);
  expect(result.clarification).toBeUndefined(); expect(result.narrativeRejected).toBe(true);
  expect(result.readOutcome).toBe("READS_COMPLETED"); expect(result.text).not.toContain("Which customer?");
  expect(result.text).not.toMatch(/\bkind\s*:\s*"clarification"/); expect(transport).toHaveBeenCalledTimes(2);
});

test("F03 rejects an oversized post-read clarification even when kind is not the first field", async () => {
  const content = JSON.stringify({ padding: "x".repeat(2100), kind: "clarification", questions: ["Which customer?"] });
  const sequence: unknown[] = [
    { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "read", type: "function", function: { name: "invoice.list", arguments: "{}" } }] } }] },
    { choices: [{ finish_reason: "stop", message: { content } }] },
  ];
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", fetchImplementation: vi.fn<typeof fetch>(async () => Response.json(sequence.shift())) });
  const result = await runQueryLoop(queryInput, [read], async () => ({ invoice: "confirmed" }), client);
  expect(result).toMatchObject({ readOutcome: "READS_COMPLETED", narrativeRejected: true });
  expect(result.clarification).toBeUndefined(); expect(result.text).not.toContain("x".repeat(100));
});

test("F03 answered clarification remains history, while a later confirmed read supplies the report", async () => {
  const sequence: unknown[] = [
    { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ kind: "clarification", questions: ["Which customer?"] }) } }] },
    { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "read", type: "function", function: { name: "invoice.list", arguments: "{}" } }] } }] },
    { choices: [{ finish_reason: "stop", message: { content: "Confirmed invoice read for Acme. No email was sent." } }] },
  ];
  const transport = vi.fn<typeof fetch>(async () => Response.json(sequence.shift()));
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", fetchImplementation: transport });
  const dispatch = vi.fn(async () => ({ invoices: [{ customer: "Acme" }] }));
  const clarification = await runQueryLoop(queryInput, [read], dispatch, client);
  expect(clarification.clarification?.questions).toEqual(["Which customer?"]);
  expect(dispatch).not.toHaveBeenCalled();
  const report = await runQueryLoop({ ...queryInput, userMessage: "Acme", chatHistory: [
    { role: "assistant", text: clarification.text }, { role: "user", text: "Acme" },
  ] }, [read], dispatch, client);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(report).toMatchObject({ readOutcome: "READS_COMPLETED", narrativeRejected: false, text: "Confirmed invoice read for Acme. No email was sent." });
  expect(report.clarification).toBeUndefined();
  expect(transport).toHaveBeenCalledTimes(3);
});

test("F03 keeps ordinary report compatibility when a successful read response omits finish_reason", async () => {
  const sequence: unknown[] = [
    { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "read", type: "function", function: { name: "invoice.list", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "Confirmed invoice read. No email was sent." } }] },
  ];
  const transport = vi.fn<typeof fetch>(async () => Response.json(sequence.shift()));
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", timeoutMs: 1000, fetchImplementation: transport });
  const result = await runQueryLoop(queryInput, [read], async () => ({ invoice: "confirmed" }), client);
  expect(result.text).toBe("Confirmed invoice read. No email was sent."); expect(result.stopReason).toBe("COMPLETED");
  expect(result.readOutcome).toBe("READS_COMPLETED"); expect(result.narrativeRejected).toBe(false); expect(result.clarification).toBeUndefined();
});

test("F03 deadline and output-token limits reject an otherwise valid clarification", async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const deadline = await runActualChoice(JSON.stringify({ kind: "clarification", questions: ["Which customer?"] }), { finish_reason: "stop" }, { beforeResponse: () => { now += 30_001; } });
    expect(deadline.result.clarification).toBeUndefined(); expect(deadline.result.boundHit).toBe(true); expect(deadline.result.stopReason).toBe("LIMIT_REACHED");
  } finally { clock.mockRestore(); }
  for (const completionTokens of [4000, 4001]) {
    const budget = await runActualChoice(JSON.stringify({ kind: "clarification", questions: ["Which customer?"] }), { finish_reason: "stop" }, { completionTokens });
    expect(budget.result.clarification).toBeUndefined(); expect(budget.result.boundHit).toBe(true); expect(budget.result.stopReason).toBe("LIMIT_REACHED");
    expect(budget.transport).toHaveBeenCalledOnce();
  }
});

test("F03 iteration exhaustion never promotes a clarification envelope", async () => {
  const idRead = toolSchema.parse({ ...read, input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
  let callIndex = 0;
  const transport = vi.fn<typeof fetch>(async () => {
    callIndex++;
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: JSON.stringify({ kind: "clarification", questions: ["Which customer?"] }),
      tool_calls: [{ id: `read-${callIndex}`, type: "function", function: { name: "invoice.list", arguments: JSON.stringify({ id: String(callIndex) }) } }] } }] });
  });
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", timeoutMs: 1000, fetchImplementation: transport });
  const result = await runQueryLoop(queryInput, [idRead], async () => ({ invoice: "confirmed" }), client);
  expect(result.clarification).toBeUndefined(); expect(result.boundHit).toBe(true); expect(result.stopReason).toBe("LIMIT_REACHED");
  expect(result.narrativeRejected).toBe(false); expect(result.readOutcome).toBe("PARTIAL_READ"); expect(result.text).not.toContain("Which customer?");
  expect(transport).toHaveBeenCalledTimes(Number(process.env.QUERY_AGENT_MAX_ITERATIONS ?? "5"));
});

test("F03 cancellation and failed reads cannot be converted into a clarification", async () => {
  const controller = new AbortController(); controller.abort();
  const cancelled = await runActualChoice(JSON.stringify({ kind: "clarification", questions: ["Which customer?"] }), { finish_reason: "stop" }, { signal: controller.signal });
  expect(cancelled.result.clarification).toBeUndefined(); expect(cancelled.result.stopReason).toBe("CANCELLED"); expect(cancelled.transport).not.toHaveBeenCalled();

  const content = JSON.stringify({ kind: "clarification", questions: ["Which customer?"] });
  const sequence = [
    { finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "read", type: "function", function: { name: "invoice.list", arguments: "{}" } }] } },
    { finish_reason: "stop", message: { content } },
  ];
  const transport = vi.fn<typeof fetch>(async () => Response.json({ choices: [sequence.shift()] }));
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", timeoutMs: 1000, fetchImplementation: transport });
  const failed = await runQueryLoop(queryInput, [read], async () => { throw new Error("read denied"); }, client);
  expect(failed.clarification).toBeUndefined(); expect(failed.readOutcome).toBe("NO_CONFIRMED_READ"); expect(failed.toolSteps[0]?.status).toBe("FAILED");
  expect(transport).toHaveBeenCalledOnce();
});

test("F03 provider cancellation during the request cannot publish a clarification", async () => {
  const controller = new AbortController();
  const transport = vi.fn<typeof fetch>(async () => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  });
  const client = new OpenAICompatibleClient({ baseURL: "https://f03-model.example.test/v1", apiKey: "synthetic-fixture-only", model: "model-b", fetchImplementation: transport });
  const result = await runQueryLoop({ ...queryInput, signal: controller.signal }, [read], async () => ({ invoice: "unreachable" }), client);
  expect(result).toMatchObject({ stopReason: "CANCELLED", readOutcome: "NO_CONFIRMED_READ", narrativeRejected: true });
  expect(result.clarification).toBeUndefined(); expect(transport).toHaveBeenCalledOnce();
});
