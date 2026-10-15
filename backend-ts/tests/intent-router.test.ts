import { expect, test, vi } from "vitest";
import { identifyChatIntent } from "../src/agent/intent-router.js";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import { loadConfig } from "../src/config/config.js";

const input = { content: "මට මේක පැහැදිලි කරන්න", history: ["assistant: The saved plan is selected"], workspace: { workflowSelected: true },
  actorId: "owner", role: "User", sessionId: "chat", traceId: "trace" };
function client(content: string, finish: string | undefined = "stop", toolCalls?: unknown[]) {
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); expect(body.tools).toBeUndefined(); expect(body.messages[0].content).toContain("SEMANTIC CONVERSATION INTENT ROUTING");
    expect(body.max_tokens).toBe(900); expect(JSON.parse(body.messages.at(-1).content).CURRENT_REQUEST).toBe(input.content);
    return Response.json({ choices: [{ ...(finish ? { finish_reason: finish } : {}), message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] });
  });
  return { transport, provider: new OpenAICompatibleClient({ baseURL: "https://models.example.test/v1", apiKey: "fixture", model: "model", temperature: 0, timeoutMs: 1000, fetchImplementation: transport }) };
}
test.each(["CONVERSATION", "WORKFLOW_DISCUSSION", "QUERY", "AUDIT", "ACTION", "WORKFLOW_MODIFY", "CAPABILITIES", "EMAIL_DELIVERY", "TOOL_CALL"])("agent semantic decision %s is a bounded enum, not execution authority", async intent => {
  const s = client(JSON.stringify({ intent, needsClarification: false }));
  expect(await identifyChatIntent(input, s.provider)).toEqual({ intent, needsClarification: false, source: "agent", toolsDispatched: false });
  expect(s.transport).toHaveBeenCalledOnce();
});
test.each([
  '{"intent":"SYSTEM_ADMIN","needsClarification":false}',
  '{"intent":"QUERY","needsClarification":false,"arguments":{"role":"admin"}}',
  '{"intent":"CONVERSATION","needsClarification":true}',
  '```json\n{"intent":"QUERY","needsClarification":false}\n```',
  "This is a query", "{}",
])("invalid or expanded route fails closed: %s", async value => {
  const s = client(value); expect(await identifyChatIntent(input, s.provider)).toMatchObject({ intent: "CONVERSATION", needsClarification: true, source: "unavailable", toolsDispatched: false });
});
test.each(["length", "tool_calls", "content_filter", "other"])("unconfirmed %s decision cannot dispatch", async finish => {
  const s = client('{"intent":"QUERY","needsClarification":false}', finish);
  expect(await identifyChatIntent(input, s.provider)).toMatchObject({ source: "unavailable", toolsDispatched: false });
});
test("ambiguous intention preserves a focused clarification rather than guessing a write", async () => {
  const s = client('{"intent":"CONVERSATION","needsClarification":true,"clarification":"Do you want an explanation or an edit proposal?"}');
  expect(await identifyChatIntent(input, s.provider)).toMatchObject({ source: "agent", needsClarification: true, clarification: "Do you want an explanation or an edit proposal?" });
});
test.each(["QUERY", "TOOL_CALL", "ACTION", "WORKFLOW_MODIFY"])("an unresolved %s intention becomes clarification only, never dispatch", async intent => {
  const s = client(JSON.stringify({ intent, needsClarification: true, clarification: "Which required item group and unit should I use?" }));
  expect(await identifyChatIntent(input, s.provider)).toMatchObject({ intent: "CONVERSATION", source: "agent", needsClarification: true, toolsDispatched: false, clarification: "Which required item group and unit should I use?" });
});

test("agent can request bounded same-chat recall, but cannot combine recall with a business operation", async () => {
  const s = client('{"intent":"CONVERSATION","needsClarification":false,"historyRecall":{"mode":"start"}}');
  expect(await identifyChatIntent(input, s.provider)).toMatchObject({ source: "agent", historyRecall: { mode: "start" } });
  const unsafe = client('{"intent":"TOOL_CALL","needsClarification":false,"historyRecall":{"mode":"start"}}');
  expect(await identifyChatIntent(input, unsafe.provider)).toMatchObject({ source: "unavailable", toolsDispatched: false });
});
test("a classifier tool call is never offered to an executor", async () => {
  const s = client("", "tool_calls", [{ id: "bad", type: "function", function: { name: "delete_everything", arguments: "{}" } }]);
  expect(await identifyChatIntent(input, s.provider)).toMatchObject({ source: "unavailable", toolsDispatched: false });
});
test("routing cancellation cannot become a fallback action", async () => {
  const controller = new AbortController(); controller.abort(); const s = client('{"intent":"TOOL_CALL","needsClarification":false}');
  await expect(identifyChatIntent({ ...input, signal: controller.signal }, s.provider)).rejects.toMatchObject({ status: 409 });
  expect(s.transport).not.toHaveBeenCalled();
});
test("normal deployments default to semantic intent routing; explicit patterns remains compatibility mode", () => {
  expect(loadConfig({ APP_ENV: "development" }).chatIntentRouting).toBe("agent");
  expect(loadConfig({ APP_ENV: "development", CHAT_INTENT_ROUTING: "patterns" }).chatIntentRouting).toBe("patterns");
  expect(loadConfig({ APP_ENV: "test", CHAT_INTENT_ROUTING: "agent" }).chatIntentRouting).toBe("agent");
  expect(() => loadConfig({ CHAT_INTENT_ROUTING: "anything" })).toThrow();
});

test.each(["run", "schedule", "pause", "publish", "review"])("saved-workflow %s intent is a typed review handoff, not permission", async workflowControl => {
  const s = client(JSON.stringify({ intent: "WORKFLOW_CONTROL", needsClarification: false, workflowControl }));
  expect(await identifyChatIntent(input, s.provider)).toEqual({ intent: "WORKFLOW_CONTROL", needsClarification: false, workflowControl, source: "agent", toolsDispatched: false });
});
test.each([
  { intent: "WORKFLOW_CONTROL", needsClarification: false },
  { intent: "WORKFLOW_CONTROL", needsClarification: false, workflowControl: "delete" },
  { intent: "QUERY", needsClarification: false, workflowControl: "run" },
  { intent: "WORKFLOW_CONTROL", needsClarification: true, clarification: "Which one?", workflowControl: "run" },
])("expanded or ambiguous workflow control cannot admit a command: %j", async decision => {
  const s = client(JSON.stringify(decision)); expect(await identifyChatIntent(input, s.provider)).toMatchObject({ source: "unavailable", toolsDispatched: false });
});

test("agent may extract only typed, non-executable schedule suggestions for review", async () => {
  const scheduleSuggestion = { cadence: "weekly", dayOfWeek: 5, localTime: "18:00", timezone: "Asia/Colombo" };
  const s = client(JSON.stringify({ intent: "WORKFLOW_CONTROL", needsClarification: false, workflowControl: "schedule", scheduleSuggestion }));
  expect(await identifyChatIntent(input, s.provider)).toMatchObject({ source: "agent", scheduleSuggestion, toolsDispatched: false });
});
test.each([
  { cadence: "weekly", dayOfWeek: 8 }, { cadence: "monthly", dayOfMonth: 31 }, { localTime: "25:00" }, { timezone: "invalid/zone" },
  { localTime: "09:00", enabled: true }, { localTime: "09:00", servicePrincipalId: "other" }, { cadence: "daily", dayOfWeek: 5 }, {},
])("untrusted schedule suggestion %j cannot broaden control authority", async scheduleSuggestion => {
  const s = client(JSON.stringify({ intent: "WORKFLOW_CONTROL", needsClarification: false, workflowControl: "schedule", scheduleSuggestion }));
  expect(await identifyChatIntent(input, s.provider)).toMatchObject({ source: "unavailable", toolsDispatched: false });
});
