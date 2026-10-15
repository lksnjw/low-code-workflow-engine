import { expect, test, vi } from "vitest";
import { classifyIntent } from "../src/agent/intent-classifier.js";
import { runAssistantConversation, workflowDiscussionSnapshot, selectedDiscussionWorkflow } from "../src/agent/workflow-discussion.js";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { buildCapabilitiesResponse } from "../src/http/handlers/chat-artifacts.js";

test("read-only capabilities do not advertise unrelated purchase-order approval or write access", () => {
  const text = buildCapabilitiesResponse([{ name: "list_companies", description: "Read companies", is_read_only: true } as any]);
  expect(text).toContain("read-only"); expect(text).not.toContain("Approve the pending request"); expect(text).not.toContain("Show me open purchase orders");
});

test.each(["hello", "thanks", "Tell me a joke", "What is the capital of France?", "What is an invoice?", "What is a workflow?", "Help me plan my presentation"])("ordinary dialogue is not an ERP retrieval: %s", message => {
  expect(classifyIntent(message)).toBe("CONVERSATION");
});
test.each(["what is this work flow", "Explain this workflow", "Why are there ten nodes?", "What does it do?", "Describe this node", "How can I change this page size?", "Is it already running?"])("selected-plan question uses discussion, not execution: %s", message => {
  expect(classifyIntent(message, { workflowContext: true })).toBe("WORKFLOW_DISCUSSION");
});
test.each(["Show me invoices", "How many employees are on sick leave?", "What is the balance of this invoice?", "Use list_uoms to fetch the first two units of measure", "Next page please"])("live business data stays on the governed ERP path: %s", message => {
  expect(classifyIntent(message, { workflowContext: true })).toBe("QUERY");
});
test("explicit edits/generation/effects do not become harmless discussion", () => {
  expect(classifyIntent("Change the workflow", { workflowContext: true })).toBe("WORKFLOW_MODIFY");
  expect(classifyIntent("Create a workflow to list invoices")).toBe("ACTION");
  expect(classifyIntent("Explain this workflow and then send the report to boss@example.test", { workflowContext: true })).not.toBe("WORKFLOW_DISCUSSION");
  expect(classifyIntent("Edit output", { workflowContext: true, nodeContext: true })).toBe("WORKFLOW_MODIFY");
});

test.each(["Run it", "Publish this workflow", "Run the directory workflow every morning at 9", "Pause this schedule"])("saved workflow command %s selects review controls, not a new draft", message => {
  expect(classifyIntent(message, { workflowContext: true })).toBe("WORKFLOW_CONTROL");
});
test("above-workflow edits and explicit new workflow generation remain separate from lifecycle controls", () => {
  expect(classifyIntent("Edit the above workflow", { workflowContext: true })).toBe("WORKFLOW_MODIFY");
  expect(classifyIntent("Create a workflow to run every morning", { workflowContext: true })).toBe("ACTION");
  expect(classifyIntent("What does this schedule do?", { workflowContext: true })).toBe("WORKFLOW_DISCUSSION");
});

const base = { content: "Hello", history: [], actorId: "owner", role: "Reader", sessionId: "chat", traceId: "test", kind: "CONVERSATION" as const };
test("ordinary conversation uses the selected provider through Pi without tools or the ERP no-data disclaimer", async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); expect(wire.tools).toBeUndefined(); expect(wire.messages[0].content).toContain("prompt/conversation/v1");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Hello! How can I help you today?" } }], usage: { prompt_tokens: 5, completion_tokens: 8 } });
  });
  const client = new OpenAICompatibleClient({ baseURL: "https://conversation.example.test/v1", apiKey: "synthetic-key", model: "fixture-model", fetchImplementation: transport });
  const result = await runAssistantConversation(base, client);
  expect(result.text).toBe("Hello! How can I help you today?"); expect(result.explanationAvailable).toBe(true);
  expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 8, measured: true }); expect(transport).toHaveBeenCalledOnce();
});
test.each(["tool call", "truncated", "missing finish", "false action"])("a conversational %s response never becomes execution evidence", async scenario => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ ...(scenario === "missing finish" ? {} : { finish_reason: scenario === "truncated" ? "length" : scenario === "tool call" ? "tool_calls" : "stop" }),
    message: { content: scenario === "false action" ? "I sent the email." : "Incomplete", ...(scenario === "tool call" ? { tool_calls: [{ id: "bad", type: "function", function: { name: "send_email", arguments: "{}" } }] } : {}) } }] }));
  const client = new OpenAICompatibleClient({ baseURL: "https://conversation.example.test/v1", apiKey: "synthetic-key", model: "fixture-model", fetchImplementation: transport });
  const result = await runAssistantConversation(base, client);
  expect(result.explanationAvailable).toBe(false); expect(result.text).toContain("no tools were called"); expect(result.text).not.toContain("I sent"); expect(transport).toHaveBeenCalledOnce();
});

const source = 'name: Directory audit\ndescription: Check reference records\ntrigger:\n  type: manual\nsteps:\n  - id: read\n    action: list_companies\n    parameters:\n      fields: \'["name"]\'\n      api_key: do-not-transmit\n';
function fixture() {
  const user: any = { id: "owner", role: "Reader", permissions: ["chat:use", "workflow:read"] };
  const state: any = { users: { owner: { id: "owner", status: "Active", roleId: "reader", permissionOverrides: [] } }, roles: { reader: { name: "Reader", permissions: user.permissions } },
    chats: { chat: { id: "chat", ownerId: "owner", messages: [] } }, workflows: { selected: { id: "selected", name: "Stored name", yaml: source, archived: false,
      owner: { id: "owner" }, assignedUserIds: [], draftVersion: 1, publishedVersion: 1, chatSessionId: "chat" } }, executions: {}, schedules: {} };
  return { state, user };
}
test("discussion uses authorized saved source, redacts credentials, and never trusts a client label/YAML", () => {
  const { state, user } = fixture();
  const value = workflowDiscussionSnapshot(state, user, "chat", { workflowId: "selected", baseVersion: 1, baseHash: workflowContentHash(source) }, []);
  expect(value).toMatchObject({ name: "Directory audit", nodeCount: 1, trigger: "manual", latestRun: null, schedule: null });
  expect(JSON.stringify(value)).not.toContain("do-not-transmit");
  expect(() => selectedDiscussionWorkflow(state, user, "chat", { workflowId: "selected", yaml: "name: fake" })).toThrow("Invalid selected workflow reference");
  expect(() => selectedDiscussionWorkflow(state, user, "chat", { workflowId: "selected", baseVersion: 2, baseHash: workflowContentHash(source) })).toThrow(/changed/);
});
test("several workflows require explicit selection, not an arbitrary source", () => {
  const { state, user } = fixture(); state.workflows.other = { ...state.workflows.selected, id: "other" };
  expect(selectedDiscussionWorkflow(state, user, "chat")).toBeNull();
});
test("chat access alone cannot reveal an unassigned workflow", () => {
  const { state, user } = fixture(); user.permissions = ["chat:use"]; state.roles.reader.permissions = user.permissions;
  state.workflows.selected.owner.id = "another-person";
  expect(() => selectedDiscussionWorkflow(state, user, "chat", { workflowId: "selected" })).toThrow("Selected workflow not found");
});
