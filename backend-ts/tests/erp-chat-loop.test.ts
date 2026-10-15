import { expect, test, vi } from "vitest";
import { runErpChatLoop } from "../src/agent/erp-chat-loop.js";
import type { QueryTurnResult } from "../src/analysisprovider/query-types.js";
import { NATURAL_INTENT_ROUTING_SYSTEM_PROMPT, ERP_CHAT_SYSTEM_PROMPT, systemInstructionsFor, toolQuerySystemInstructionsFor } from "../src/prompts/contracts.js";
import { queryChatPresentation } from "../src/agent/query-chat-presentation.js";

const item = { name: "create_item", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: {
  item_code: { type: "string" }, item_group: { type: "string", enum: ["Products"] }, is_stock_item: { type: "integer" },
}, required: ["item_code", "item_group", "is_stock_item"], additionalProperties: false } };
const list = { name: "list_items", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { fields: { type: "string" }, limit_page_length: { type: "integer" } }, required: ["limit_page_length"], additionalProperties: false } };
const toolTurn = (name: string, args: Record<string, unknown>): QueryTurnResult => ({ text: "", toolCalls: [{ id: `call_${Math.random()}`, name, arguments: args }], stopReason: "tool_calls", inputTokens: 10, outputTokens: 10, measured: true });
const textTurn = (text: string): QueryTurnResult => ({ text, toolCalls: [], stopReason: "stop", completionConfirmed: true, inputTokens: 10, outputTokens: 10, measured: true });
function setup(turns: QueryTurnResult[]) {
  const read = vi.fn(async () => ({ content: [{ type: "text", text: '[{"name":"QA-1"}]' }] }));
  const propose = vi.fn(async (_tool: unknown, _args: Record<string, unknown>) => ({ id: "proposal", status: "PENDING" }));
  const queryWithTools = vi.fn(async () => { const next = turns.shift(); if (!next) throw new Error("Unexpected extra model turn"); return next; });
  const input = { content: "Create an item", history: [], actorId: "admin", role: "Platform Admin", sessionId: "chat", traceId: "test", catalog: [item, list], read, propose };
  return { input, read, propose, queryWithTools, run: () => runErpChatLoop(input, { queryWithTools }) };
}
test("natural routing distinguishes direct ERP changes, analyses, and explicitly requested workflows", () => {
  expect(systemInstructionsFor("prompt/intent-routing/v2")).toBe(NATURAL_INTENT_ROUTING_SYSTEM_PROMPT);
  expect(NATURAL_INTENT_ROUTING_SYSTEM_PROMPT).toContain('"Create an order from this image" is TOOL_CALL');
  expect(NATURAL_INTENT_ROUTING_SYSTEM_PROMPT).toContain('"Create a workflow to extract an image and create an order" is ACTION');
  expect(toolQuerySystemInstructionsFor("prompt/erp-chat/v1")).toBe(ERP_CHAT_SYSTEM_PROMPT);
});
test("chat uses three small tools, not all remote schemas, and stops at a durable exact proposal", async () => {
  const s = setup([toolTurn("erp_tool_catalog", { search: "item" }), toolTurn("erp_tool_schema", { toolName: "create_item" }),
    toolTurn("erp_invoke", { toolName: "create_item", arguments: { item_code: "QA-1", item_group: "Products", is_stock_item: 1 } })]);
  const result = await s.run();
  expect(s.read).not.toHaveBeenCalled(); expect(s.propose).toHaveBeenCalledOnce(); expect(result.erpActionProposals).toHaveLength(1);
  expect(result.text).toContain("No ERP change has been made"); expect(result).not.toHaveProperty("workflowDraft");
  expect(result.text).toContain("Create item"); expect(result.text).not.toContain("create_item");
  expect(s.queryWithTools.mock.calls).toHaveLength(3);
});

test("a plain registration request is mapped to a live customer contract and not a login or workflow", async () => {
  const customer = { name: "create_customer", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: {
    customer_name: { type: "string" }, customer_group: { type: "string" }, territory: { type: "string" },
  }, required: ["customer_name", "customer_group", "territory"], additionalProperties: false } };
  const args = { customer_name: "QA plain customer", customer_group: "Demo", territory: "Sri Lanka" };
  const s = setup([toolTurn("erp_tool_catalog", { search: "register client" }), toolTurn("erp_tool_schema", { toolName: "create_customer" }),
    toolTurn("erp_invoke", { toolName: "create_customer", arguments: args })]);
  s.input.content = "Register this client using the details I reviewed in the form. No workflow needed.";
  s.input.catalog.push(customer as any);
  const result = await s.run();
  expect(s.propose).toHaveBeenCalledExactlyOnceWith(customer, args); expect(s.read).not.toHaveBeenCalled();
  expect(result.text).toContain("Create customer"); expect(result.text).not.toContain("create_customer");
  expect(result.erpActionProposals).toHaveLength(1); expect(result).not.toHaveProperty("workflowDraft");
});

test("email composition formats the outgoing payload, not the chat reply, before validation and exact confirmation", async () => {
  const email = { name: "resend-email-send", description: "Send an email", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: {
    to: { type: "array", items: { type: "string" } }, from: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, html: { type: "string" }, idempotency_key: { type: "string" },
  }, required: ["to", "from", "subject", "text", "idempotency_key"], additionalProperties: false } };
  const args = { to: ["recipient@example.test"], from: "sender@example.test", subject: "Orders", text: "## Sales orders\n| Order | Total |\n|---|---|\n| SO-1 | 12,000 |", html: "<html>Untrusted model styling</html>", idempotency_key: "original-key" };
  const s = setup([toolTurn("erp_tool_schema", { toolName: email.name }), toolTurn("erp_invoke", { toolName: email.name, arguments: args })]);
  s.input.content = "Email these details neatly"; s.input.catalog.push(email as any);
  const result = await s.run();
  expect(s.propose).toHaveBeenCalledOnce(); expect(s.read).not.toHaveBeenCalled();
  const offered = s.propose.mock.calls[0]![1] as any;
  expect(offered.text).toBe(args.text); expect(offered.html).toContain('aria-label="Report details"');
  expect(offered.html).not.toContain("Untrusted model styling"); expect(offered.idempotency_key).toBe("original-key");
  expect(result.erpActionProposals).toHaveLength(1); expect(result.text).toContain("confirm"); expect(result.text).not.toContain("<html>");
});

test("required-field guidance inspects metadata without invoking or proposing a business action", async () => {
  const s = setup([toolTurn("erp_tool_catalog", { search: "create_item" }), toolTurn("erp_tool_schema", { toolName: "create_item" }),
    textTurn("The current contract requires item_code, item_group and is_stock_item. No record was created.")]);
  s.input.content = "Which fields are required to create an item? Do not create anything.";
  const result = await s.run();
  expect(result.text).toContain("current contract requires");
  expect(s.read).not.toHaveBeenCalled(); expect(s.propose).not.toHaveBeenCalled();
  expect(result.toolSteps).toHaveLength(0); expect(result.erpActionProposals).toHaveLength(0);
  expect(NATURAL_INTENT_ROUTING_SYSTEM_PROMPT).toContain("Questions about the connected ERP's required/optional inputs");
  expect(NATURAL_INTENT_ROUTING_SYSTEM_PROMPT).toContain('"do not create anything"');
  expect(systemInstructionsFor("prompt/conversation/v1")).toContain("Never present a generic onboarding checklist");
});
test.each([
  { item_code: "QA-1" },
  { item_code: "QA-1", item_group: "Unknown", is_stock_item: 1 },
  { item_code: ["QA-1"], item_group: "Products", is_stock_item: 1 },
  { item_code: "QA-1", item_group: "Products", is_stock_item: true },
])("mandatory inputs, enums and declared scalar types block effects: %j", async args => {
  const s = setup([toolTurn("erp_tool_schema", { toolName: "create_item" }), toolTurn("erp_invoke", { toolName: "create_item", arguments: args }), textTurn("Which item group and stock flag should I use?")]);
  const result = await s.run();
  expect(s.propose).not.toHaveBeenCalled(); expect(s.read).not.toHaveBeenCalled(); expect(result.text).toContain("Which item group");
});
test("the agent can correct JSON-string shape before dispatch without silently changing input values", async () => {
  const s = setup([toolTurn("erp_tool_schema", { toolName: "list_items" }), toolTurn("erp_invoke", { toolName: "list_items", arguments: { fields: ["name"], limit_page_length: 2 } }),
    toolTurn("erp_invoke", { toolName: "list_items", arguments: { fields: '["name"]', limit_page_length: 2 } }), textTurn("The first result is QA-1.")]);
  const result = await s.run(); expect(s.read).toHaveBeenCalledOnce(); expect(s.read).toHaveBeenCalledWith(list, { fields: '["name"]', limit_page_length: 2 });
  expect(result.toolSteps).toHaveLength(1); expect(result).not.toHaveProperty("yaml"); expect(s.propose).not.toHaveBeenCalled();
});
test("a tool schema must be fetched before any read or proposal", async () => {
  const s = setup([toolTurn("erp_invoke", { toolName: "create_item", arguments: { item_code: "QA-1", item_group: "Products", is_stock_item: 1 } }), textTurn("I need to inspect this tool first.")]);
  await s.run(); expect(s.propose).not.toHaveBeenCalled(); expect(s.read).not.toHaveBeenCalled();
});
test.each(["remote error", "transport error"])("%s stops rather than retrying or inventing success", async kind => {
  const s = setup([toolTurn("erp_tool_schema", { toolName: "list_items" }), toolTurn("erp_invoke", { toolName: "list_items", arguments: { limit_page_length: 2 } })]);
  if (kind === "remote error") s.read.mockImplementationOnce(async () => ({ content: [], isError: true } as any)); else s.read.mockRejectedValueOnce(new Error("timeout"));
  const result = await s.run(); expect(result.blocked).toBe(true); expect(s.read).toHaveBeenCalledOnce(); expect(s.queryWithTools).toHaveBeenCalledTimes(2);
});
test("ordinary retrieval never creates even a hidden workflow draft", () => {
  const result = queryChatPresentation("QUERY", "List items", null, { readOutcome: "READS_COMPLETED", narrativeRejected: false, toolSteps: [{ toolName: "list_items", arguments: {}, result: {}, status: "SUCCEEDED" }], toolCallLog: [] } as any);
  expect(result.workflowDraft).toBeUndefined(); expect(result.artifacts).not.toHaveProperty("workflowDraft");
});
test("a server-classified absent-record lookup may continue to the explicitly requested create proposal", async () => {
  const absent = { name: "get_item", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
  const s = setup([toolTurn("erp_tool_schema", { toolName: "get_item" }), toolTurn("erp_invoke", { toolName: "get_item", arguments: { name: "QA-1" } }),
    toolTurn("erp_tool_schema", { toolName: "create_item" }), toolTurn("erp_invoke", { toolName: "create_item", arguments: { item_code: "QA-1", item_group: "Products", is_stock_item: 1 } })]);
  s.input.catalog.push(absent as any); s.read.mockResolvedValueOnce({ content: [], isError: true, readBusinessOutcome: "NOT_FOUND" } as any);
  const result = await s.run(); expect(result.blocked).toBe(false); expect(result.toolSteps[0]!.status).toBe("NOT_FOUND"); expect(s.propose).toHaveBeenCalledOnce();
});
