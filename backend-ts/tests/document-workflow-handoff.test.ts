import { afterEach, expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { processStoredChat } from "../src/http/handlers/chat.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import { reviewedDocumentChatContext } from "../src/documents/chat-document-context.js";
import type { SynthesisInput, SynthesisResult } from "../src/synthesis/service.js";
import { ReadAdmissionUnavailableError } from "../src/tools/read-tool-broker.js";

const isolated = vi.hoisted(() => ({ read: vi.fn(), discover: vi.fn(), direct: vi.fn(), directEnabled: false }));
vi.mock("../src/documents/direct-library.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/documents/direct-library.js")>(), directLibraryConfigured: () => isolated.directEnabled, dispatchDirectLibraryRead: isolated.direct }));
vi.mock("../src/tools/read-tool-broker.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/tools/read-tool-broker.js")>(), dispatchReadTool: isolated.read }));
vi.mock("../src/agent/tool-discovery.js", () => ({ discoverTools: isolated.discover }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function setup() {
  isolated.directEnabled = false;
  const repository = new Repository();
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: "" };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Client import", createdAt: "", updatedAt: "", messageCount: 1, messages: [{ id: "request", role: "user", text: "Add these clients", createdAt: "" }] };
    state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false };
  });
  const user = (await repository.effectiveUser("owner"))!;
  const config = loadConfig({ APP_ENV: "test", CHAT_INTENT_ROUTING: "agent", PIPELINE_API_BASE_URL: "http://pipeline.test", PIPELINE_API_KEY: "isolated-document-handoff-key" });
  const queryWithTools = vi.fn(async () => { throw new Error("A reviewed workflow selection must not enter direct ERP chat"); });
  const synthesize = vi.fn<(input: SynthesisInput) => Promise<SynthesisResult>>().mockRejectedValue(new Error("Synthetic stop at drafting boundary, no provider or ERP write"));
  const services = { repository, config, providerRuntime: { configured: true, queryWithTools }, synthesis: { synthesize } } as unknown as HandlerServices;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ session_id: "chat", status: "READY", document_id: "doc", version: 2 })));
  isolated.discover.mockResolvedValue([{ name: "pipeline-library-resolve", mcp_tool_name: "pipeline-library-resolve", is_read_only: true, allowed_roles: [user.role] }]);
  isolated.read.mockResolvedValue({ structuredContent: { document_id: "doc", upload_id: "upload", version: 2,
    form_rows: [{ customer_name: "Client A" }, { customer_name: "Client B" }] } });
  const documentContext = { uploadId: "upload", documentId: "doc", version: 2, purpose: "erp_record_proposal" };
  const stored = { session: { id: "chat" }, userMessage: { id: "request" }, priorMessages: [] } as unknown as Parameters<typeof processStoredChat>[0]["stored"];
  return { repository, services, user, documentContext, queryWithTools, synthesize, stored };
}

test("explicit document workflow handoff cannot be reclassified as direct ERP execution", async () => {
  const s = await setup();
  await processStoredChat({ body: { documentContext: s.documentContext }, content: "Add these clients", sessionId: "chat", traceId: "document-workflow", stored: s.stored, user: s.user, services: s.services });
  expect(s.queryWithTools).not.toHaveBeenCalled(); expect(s.synthesize).toHaveBeenCalledOnce();
  expect(isolated.read).toHaveBeenCalledWith(s.services, "owner", "pipeline-library-resolve", { document_id: "doc" }, expect.any(Object));
  const source = s.synthesize.mock.calls[0]?.[0] as unknown as { priorMessages: string[] };
  expect(source.priorMessages.join("\n")).toContain("Client A"); expect(source.priorMessages.join("\n")).toContain("Client B");
  expect(source.priorMessages.join("\n")).toContain("not arbitrary repeated client-list imports");
  expect(Object.keys((await s.repository.snapshot()).workflows)).toHaveLength(0);
});

test("direct pipeline document workflow does not need bridge document-tool admission", async () => {
  const s = await setup(); isolated.directEnabled = true;
  isolated.direct.mockResolvedValue({ structuredContent: { document_id: "doc", upload_id: "upload", version: 2, form_fields: { customer_name: "Reviewed Client" } } });
  await processStoredChat({ body: { documentContext: s.documentContext }, content: "Create a workflow to register this customer", sessionId: "chat", traceId: "direct-source", stored: s.stored, user: s.user, services: s.services });
  expect(isolated.direct).toHaveBeenCalledWith(s.services, s.user, "chat", "pipeline-library-resolve", { document_id: "doc" }, expect.any(Object));
  expect(isolated.read).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled(); expect(s.synthesize).toHaveBeenCalledOnce();
});

test("mixed or forged document scope is rejected before any pipeline/tool/model request", async () => {
  const s = await setup();
  await expect(processStoredChat({ body: { documentContext: s.documentContext, nodeContext: {} }, content: "Add clients", sessionId: "chat", traceId: "mixed", stored: s.stored, user: s.user, services: s.services })).rejects.toMatchObject({ status: 422 });
  expect(fetch).not.toHaveBeenCalled(); expect(isolated.read).not.toHaveBeenCalled(); expect(s.synthesize).not.toHaveBeenCalled();
});

test("a structurally valid document proposal is saved for later canvas review, with both clients and runtime approvals intact", async () => {
  const s = await setup();
  const yaml = "name: Reviewed client import\ndescription: Source doc version 2\ntrigger: {type: manual}\nsteps:\n  - {id: approve_a, kind: approval, description: Review Client A}\n  - {id: create_a, action: create_customer, parameters: {customer_name: Client A}}\n  - {id: approve_b, kind: approval, description: Review Client B}\n  - {id: create_b, action: create_customer, parameters: {customer_name: Client B}}\n";
  const validation = { passed: false, score: 0, failed_rules: [], warnings: ["No admitted create contract in this isolated fixture"] };
  const candidate = { id: "candidate_1", candidate_id: "candidate_1", status: "BLOCKED", score: 0, yaml, validation,
    generation_metadata: { model: "isolated-model", provider: "isolated", promptTemplateVersion: "prompt/candidate/v21", promptSha256: "sha", inputTokens: 1, outputTokens: 1, measured: false, temperature: 0 } };
  s.synthesize.mockResolvedValueOnce({ yaml, validation, candidate, candidates: [candidate], can_execute: false, canExecute: false,
    selected_candidate_id: "candidate_1", selected_workflow_yaml: yaml, validation_summary: { passed_candidates: 0, blocked_candidates: 1, best_score: 0 },
    blocking_errors: ["Create API requires review"], execution_profile_issues: [], next_action: "escalate", retrieval: {} } as unknown as SynthesisResult);
  const response = await processStoredChat({ body: { documentContext: s.documentContext }, content: "Draft a workflow for these clients", sessionId: "chat", traceId: "save-document-draft", stored: s.stored, user: s.user, services: s.services });
  const state = await s.repository.snapshot(), saved = Object.values(state.workflows);
  expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ yaml, publishedVersion: 0, draftVersion: 1, canRun: false, chatSessionId: "chat", lastRunAt: null });
  expect(saved[0]?.pendingGenerationApproval?.steps).toHaveLength(2);
  expect(response.data?.assistantMessage).toMatchObject({ artifacts: { workflowId: saved[0]?.id, can_execute: false } });
  expect(state.executions).toEqual({}); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("stale or unowned reviewed-document handoffs cannot reach workflow drafting", async () => {
  const s = await setup();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ session_id: "chat", status: "READY", document_id: "doc", version: 3 }));
  await expect(processStoredChat({ body: { documentContext: s.documentContext }, content: "Draft clients", sessionId: "chat", traceId: "stale", stored: s.stored, user: s.user, services: s.services })).rejects.toMatchObject({ status: 409 });
  expect(s.synthesize).not.toHaveBeenCalled(); expect(isolated.read).not.toHaveBeenCalled();
});

test("reviewed forms become per-run inputs without forcing another publication for new files", async () => {
  const s = await setup();
  const context = await reviewedDocumentChatContext(s.services, s.user, "chat", s.documentContext, async () => isolated.read());
  expect(context).toContain("not a live file watcher"); expect(context).toContain("do not need a new workflow revision or publication");
  expect(context).toContain("trigger.config.inputSchema"); expect(context).toContain("{{input.field}}");
  expect(context).not.toContain("as reviewed literal inputs"); expect(context).toContain("fresh exact human runtime approval");
  expect(context).toContain("cadence, time, timezone and execution identity"); expect(context).toContain("Do not invent a cron tool");
});

test("multiple reviewed source versions are all checked and kept in the builder context", async () => {
  const s = await setup();
  vi.mocked(fetch).mockImplementation(async url => Response.json({ session_id: "chat", status: "READY", document_id: String(url).includes("upload-two") ? "doc-two" : "doc", version: 2 }));
  const read = vi.fn(async (_name, args) => ({ structuredContent: { document_id: args.document_id, upload_id: args.document_id === "doc-two" ? "upload-two" : "upload", version: 2,
    form_rows: [{ customer_name: args.document_id === "doc-two" ? "Customer PDF" : "Customer Image" }] } }));
  const context = await reviewedDocumentChatContext(s.services, s.user, "chat", { purpose: "erp_record_proposal", documents: [s.documentContext, { uploadId: "upload-two", documentId: "doc-two", version: 2 }].map(({ uploadId, documentId, version }) => ({ uploadId, documentId, version })) }, read);
  expect(read).toHaveBeenCalledTimes(2); expect(context).toContain("Customer PDF"); expect(context).toContain("Customer Image");
  expect(context).toContain("same published workflow and tools"); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("one stale source blocks the entire source set before document resolution", async () => {
  const s = await setup(), read = vi.fn();
  await expect(reviewedDocumentChatContext(s.services, s.user, "chat", { purpose: "erp_record_proposal", documents: [
    { uploadId: "upload", documentId: "doc", version: 2 }, { uploadId: "other", documentId: "other-doc", version: 3 },
  ] }, read)).rejects.toMatchObject({ status: 409 });
  expect(read).not.toHaveBeenCalled(); expect(s.synthesize).not.toHaveBeenCalled();
});

test("duplicate selected sources and excessive files cannot enter generation", async () => {
  const s = await setup(), read = vi.fn(), identity = { uploadId: "upload", documentId: "doc", version: 2 };
  for (const documents of [[identity, identity], Array.from({ length: 7 }, (_, at) => ({ ...identity, uploadId: `u-${at}`, documentId: `d-${at}` }))])
    await expect(reviewedDocumentChatContext(s.services, s.user, "chat", { purpose: "erp_record_proposal", documents }, read)).rejects.toMatchObject({ status: 422 });
  expect(read).not.toHaveBeenCalled();
});

test("a pre-dispatch document admission failure saves actionable guidance, not an empty workflow or generic failed chat", async () => {
  const s = await setup(); isolated.read.mockRejectedValueOnce(new ReadAdmissionUnavailableError());
  const response = await processStoredChat({ body: { documentContext: s.documentContext }, content: "Register these clients", sessionId: "chat", traceId: "document-admission", stored: s.stored, user: s.user, services: s.services });
  expect(response.data?.assistantMessage).toMatchObject({ artifacts: { code: "DOCUMENT_BRIDGE_REVIEW_REQUIRED", can_execute: false, toolsDispatched: false, documentContext: s.documentContext } });
  expect(s.synthesize).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
  const state = await s.repository.snapshot(); expect(Object.keys(state.workflows)).toHaveLength(0); expect(Object.keys(state.executions)).toHaveLength(0);
});

test("an advertised but unadmitted document tool shows review guidance before any content-read attempt", async () => {
  const s = await setup(); isolated.discover.mockResolvedValueOnce([]);
  const response = await processStoredChat({ body: { documentContext: s.documentContext }, content: "Register these clients", sessionId: "chat", traceId: "document-no-offer", stored: s.stored, user: s.user, services: s.services });
  expect(response.data?.assistantMessage).toMatchObject({ artifacts: { code: "DOCUMENT_BRIDGE_REVIEW_REQUIRED", toolsDispatched: false } });
  expect(isolated.read).not.toHaveBeenCalled(); expect(s.synthesize).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("a transport error cannot impersonate the typed pre-dispatch admission refusal", async () => {
  const s = await setup(); isolated.read.mockRejectedValueOnce(new Error("Tool dispatch denied: tool has no unique admitted live contract"));
  await expect(processStoredChat({ body: { documentContext: s.documentContext }, content: "Register these clients", sessionId: "chat", traceId: "not-admission", stored: s.stored, user: s.user, services: s.services })).rejects.toThrow("Tool dispatch denied");
  expect(s.synthesize).not.toHaveBeenCalled();
});

test("revoked authority cannot save document recovery guidance after the read check", async () => {
  const s = await setup(); isolated.read.mockImplementationOnce(async () => { await s.repository.mutate(state => { state.users.owner!.status = "Suspended"; }); throw new ReadAdmissionUnavailableError(); });
  await expect(processStoredChat({ body: { documentContext: s.documentContext }, content: "Register these clients", sessionId: "chat", traceId: "revoked-admission", stored: s.stored, user: s.user, services: s.services })).rejects.toBeDefined();
  expect(s.synthesize).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).chats.chat!.messages).toHaveLength(1);
});
