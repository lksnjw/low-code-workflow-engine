/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, beforeEach, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { operationReadbackService } from "../../services/operation-readback.service";
import { statusHistory } from "../../services/operation-readback.fixture";
import { within } from "@testing-library/react";
import { iterationFixture } from "../../utils/iterationEvidence.fixture";

const yaml = "name: Report\ntrigger:\n  type: manual\nsteps:\n - id: first\n   action: demo.echo\n   parameters:\n     value: original\n - id: last\n   action: demo.echo\n   parameters:\n     value: tail\n";
const record = { workflowId: "report", version: 1, contentHash: `sha256:${"a".repeat(64)}`, yaml, validation: { passed: true, errors: [] }, published: false, bridge: "not_connected", can_attempt_run: false };
const proposal = { id: "proposal-one", workflowId: "report", nodeId: "first", baseVersion: 1, baseHash: record.contentHash, status: "PROPOSED", before: { id: "first", action: "demo.echo", parameters: { value: "original" } }, after: { id: "first", action: "demo.echo", parameters: { value: "proposed" } }, command: { type: "updateNode", nodeId: "first", patch: { parameters: { value: "proposed" } } } };
let messages = [];
const send = jest.fn();
jest.unstable_mockModule("../../hooks/useChat", () => ({ useChat: () => ({ messages, send, loading: false }) }));
const { default: WorkflowWorkspaceEditor } = await import("./WorkflowWorkspaceEditor");
const { default: ChatWorkspaceLayout } = await import("./ChatWorkspaceLayout");
beforeEach(() => {
  messages = []; send.mockReset(); send.mockResolvedValue({ operation: { id: "saved" } });
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(workflowService, "command").mockResolvedValue({ ...record, version: 2 });
  jest.spyOn(workflowService, "proposeNode").mockResolvedValue(proposal);
  jest.spyOn(workflowService, "publish").mockResolvedValue({});
  jest.spyOn(workflowService, "run").mockResolvedValue({ id: "run-one", status: "DONE", stepOutputs: {} });
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(executionService, "getTimeline").mockResolvedValue([]);
  jest.spyOn(executionService, "get").mockResolvedValue({ id: "run-failed", status: "FAILED", workflowSnapshot: { version: 1 }, stepOutputs: { first: { structuredContent: { value: "real answer" } } } });
  jest.spyOn(operationReadbackService, "history").mockImplementation(async id => ({ ...statusHistory(), executionId: id, nodeId: "first", jobs: [], canQuery: false }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); jest.restoreAllMocks(); });
async function open(props = {}) {
  const view = render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit selectionStorageKey="account.chat" {...props} />);
  await screen.findByRole("button", { name: /first/ });
  return view;
}
async function selectNode() { fireEvent.click(screen.getByRole("button", { name: /01 first/ })); }

test("workspace canvas fills its pane and docks controls and unsaved node fields without executing anything", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  render(<ChatWorkspaceLayout storageKey="dock.layout" chat={<textarea aria-label="Message to workflow assistant" />} canvas={<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit simple selectionStorageKey="dock.selection" />} />);
  const first = await screen.findByRole("button", { name: "Select step first", exact: true });
  const surface = screen.getByLabelText("Workflow node connections");
  expect(surface.style.height).toBe("");
  expect(surface.className).toContain("flex-1");
  expect(screen.queryByRole("heading", { name: "Report", exact: true })).toBeNull();
  fireEvent.click(first);
  const tools = screen.getByRole("complementary", { name: "Workspace tools", exact: true });
  expect(within(tools).getByRole("heading", { name: "Report", exact: true })).toBeTruthy();
  const label = within(tools).getByRole("textbox", { name: "Node label", exact: true });
  fireEvent.change(label, { target: { value: "Keep this unsaved edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Close workspace tools" }));
  expect(screen.queryByRole("textbox", { name: "Node label" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Canvas only", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Full screen canvas", exact: true }));
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("canvas");
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools", exact: true }));
  expect(screen.getByRole("textbox", { name: "Node label", exact: true })).toBe(label);
  expect(label.value).toBe("Keep this unsaved edit");
  fireEvent.click(screen.getByRole("button", { name: "Exit full screen canvas", exact: true }));
  expect(screen.getByRole("textbox", { name: "Node label", exact: true })).toBe(label);
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(workflowService.publish).not.toHaveBeenCalled();
  expect(workflowService.run).not.toHaveBeenCalled();
});

test("historical publication with invalid current source shows blocked and cannot republish", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, validation: { passed: false, errors: ["Duplicate node ID"] }, compilation: { state: "BLOCKED" } });
  await open();
  expect(screen.getByText("Published · blocked")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Republish reviewed draft" }).disabled).toBe(true);
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("a 101-step generated workflow stays selectable and revision-bound in the frontend editor", async () => {
  const steps = Array.from({ length: 101 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return { id: `scale_${ordinal}`, action: `qa_scale_read_${ordinal}`, description: `Scale ERP read ${ordinal}`, parameters: {} };
  });
  const largeYaml = `name: Large ERP workflow\ntrigger:\n  type: manual\nsteps:\n${steps.map(step => `  - id: ${step.id}\n    action: ${step.action}\n    description: ${step.description}\n    parameters: {}`).join("\n")}\n`;
  workflowService.readiness.mockResolvedValue({ ...record, name: "Large ERP workflow", yaml: largeYaml,
    authoring: { profile: "read-authoring/v1", connectionId: "erpbridge-default", connectionChoices: [{ id: "erpbridge-default", primary: true }],
      nodes: steps.map(step => ({ nodeId: step.id, effectClass: "read", actions: [step.action], inputSchema: { type: "object", properties: {} }, dataSources: [] })) } });
  const context = jest.fn();
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit onNodeContext={context} />);
  const rendered = await screen.findAllByRole("button", { name: /Scale ERP read/ });
  expect(rendered).toHaveLength(101);
  fireEvent.click(screen.getByRole("button", { name: /101 Scale ERP read 101/ }));
  expect(context).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", nodeId: "scale_101", version: 1, contentHash: record.contentHash, pending: false }));
  expect(screen.getByRole("complementary", { name: "Selected node details" })).toBeTruthy();
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test.each([undefined, { structuredContent: { value: "confirmed result" } }])("a stale running timeline does not contradict an acknowledged node answer %j", async output => {
  executionService.list.mockResolvedValue([{ id: "saved-run", workflowId: "report", status: "DONE", startedAt: "2026-10-11T00:00:00Z", workflowSnapshot: { yaml }, stepOutputs: output === undefined ? {} : { first: output } }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "RUNNING", phase: "DISPATCH_INTENT" }]);
  await open();
  if (output === undefined) {
    await screen.findByText("Read dispatch recorded · waiting for a saved answer");
    expect(screen.queryByText(/Node answer/)).toBeNull();
  } else {
    await screen.findByText(/Node answer/);
    expect(screen.queryByText("Read dispatch recorded · waiting for a saved answer")).toBeNull();
  }
});

function protectedRecord(profile = "protected-operation-v1") {
  const flow = { kind: "sequence", nodes: [{ kind: "protect", id: "group", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, handler: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] }, output: { schema: { type: "string" }, success: { kind: "literal", value: "found" }, handled: { kind: "literal", value: "fallback" } } }] };
  return { ...record, yaml: `${yaml}metadata:\n  controlFlow: ${JSON.stringify({ schemaVersion: "read-control-flow/v4", root: flow })}\n`, executionProfile: profile, operation_job_admission: "operation-job/v1", authoring: { profile: "read-authoring/v1", executionProfile: profile, controlFlow: flow, nodes: [] } };
}

function protectedChatRecord() {
  const saved = protectedRecord(); saved.authoring.protectedGroups = [{ nodeId: "group", patchVersion: "prompt/protected-group-patch/v1", outputSources: { success: [], handled: [] } }]; return saved;
}

test("current protected guidance enables exact group scope in shared chat and mobile focus without duplicate composer", async () => {
  const saved = protectedChatRecord(), context = jest.fn(), focus = jest.fn(); workflowService.readiness.mockResolvedValue(saved);
  await open({ onNodeContext: context, onFocusChat: focus }); fireEvent.click(screen.getByRole("button", { name: "Select protected group group" }));
  expect(context).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", nodeId: "group", version: 1, contentHash: saved.contentHash, unavailableReason: null, pending: false }));
  expect(screen.getByText(/This protected group is selected in the main chat/)).toBeTruthy(); expect(screen.queryByRole("textbox", { name: "Selected node prompt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit this group in chat" })); expect(focus).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
});

test("standalone protected prompt sends only exact node context and waits for explicit proposal Apply", async () => {
  const saved = protectedChatRecord(); workflowService.readiness.mockResolvedValue(saved); await open();
  fireEvent.click(screen.getByRole("button", { name: "Select protected group group" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Change the handled output" } }); fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Change the handled output", undefined, { nodeContext: { workflowId: "report", nodeId: "group", baseVersion: 1, baseHash: saved.contentHash } }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test.each([undefined, "prompt/protected-group-patch/v0", "prompt/protected-group-patch/v2"])("missing or unknown protected guidance %s keeps group chat blocked and offers manual output editing", async patchVersion => {
  const saved = protectedChatRecord(); saved.authoring.protectedGroups[0].patchVersion = patchVersion; workflowService.readiness.mockResolvedValue(saved);
  const context = jest.fn(); await open({ onNodeContext: context }); fireEvent.click(screen.getByRole("button", { name: "Select protected group group" }));
  expect(context).toHaveBeenLastCalledWith(expect.objectContaining({ unavailableReason: expect.stringContaining("guidance is unavailable") }));
  expect(screen.queryByRole("button", { name: "Propose change" })).toBeNull(); expect(screen.getByRole("button", { name: "Preview protected output edit" })).toBeTruthy();
});

test("saved group proposal restores readable preview and exact revision-bound Apply without body changes or execution", async () => {
  const saved = protectedChatRecord(), before = saved.authoring.controlFlow.nodes[0], output = { ...before.output, handled: { kind: "literal", value: "Explicit new handler answer" } };
  const change = { id: "group-proposal", workflowId: "report", nodeId: "group", baseVersion: 1, baseHash: saved.contentHash, status: "PROPOSED", before, after: { ...before, output }, command: { type: "updateProtected", nodeId: "group", patch: { output } } };
  workflowService.readiness.mockResolvedValue(saved); await open({ onNodeContext: jest.fn(), savedProposals: [change] });
  const preview = screen.getByRole("region", { name: "Node change preview" });
  expect(within(preview).getByText("Explicit new handler answer")).toBeTruthy(); expect(within(preview).getByText(/error policy, body and handler stay unchanged/)).toBeTruthy(); expect(preview.querySelector("pre")).toBeNull();
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: saved.contentHash, proposalId: change.id }), change.command));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("protected group output edits are readable revision-bound previews, never implicit publication or execution", async () => {
  const saved = protectedRecord(), context = jest.fn(); workflowService.readiness.mockResolvedValue(saved); await open({ onNodeContext: context });
  fireEvent.click(screen.getByRole("button", { name: "Select protected group group" }));
  expect(screen.getByRole("complementary", { name: "Selected protected group details" })).toBeTruthy();
  expect(context).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "group", version: 1, unavailableReason: expect.stringContaining("Protected-group") }));
  fireEvent.change(screen.getByRole("textbox", { name: "Handled error output" }), { target: { value: "No matching department" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview protected output edit" }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(within(screen.getByRole("region", { name: "Node change preview" })).queryByText("No matching department")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: saved.contentHash }), { type: "updateProtected", nodeId: "group", patch: { output: { ...saved.authoring.controlFlow.nodes[0].output, handled: { kind: "literal", value: "No matching department" } } } }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("protected handler children retain exact chat scope and body/handler move destinations", async () => {
  const saved = protectedRecord(), context = jest.fn(); workflowService.readiness.mockResolvedValue(saved); await open({ onNodeContext: context });
  fireEvent.click(screen.getByRole("button", { name: /02 last/ }));
  expect(context).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "last", unavailableReason: null }));
  expect(screen.queryByRole("button", { name: "Wrap node in collection" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Move node destination" }), { target: { value: "group:body" } });
  fireEvent.click(screen.getByRole("button", { name: "Move to selected scope end" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1 }), { type: "moveNode", nodeId: "last", beforeNodeId: null, destination: { protectedId: "group", scope: "body" } }));
  expect(workflowService.run).not.toHaveBeenCalled();
});

test("protected Return insertion requires current guidance and routes to the exact handler scope", async () => {
  const saved = protectedRecord(); saved.authoring.returnNodesSupported = true; workflowService.readiness.mockResolvedValue(saved); await open();
  fireEvent.click(screen.getByRole("button", { name: "Add return" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New return ID" }), { target: { value: "answer" } });
  fireEvent.change(screen.getByRole("combobox", { name: "New return destination" }), { target: { value: "group:handler" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Return value" }), { target: { value: "Handled answer" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview new return" })); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.anything(), expect.objectContaining({ type: "addReturn", nodeId: "answer", destination: { protectedId: "group", scope: "handler" } })));
  expect(workflowService.run).not.toHaveBeenCalled();
});

test.each(["protected-operation-v1", "protected-draft-runtime-pending"])("protected %s does not infer unsupported Return/simulation controls", async profile => {
  workflowService.readiness.mockResolvedValue(protectedRecord(profile)); await open();
  expect(screen.getByRole("button", { name: "Add return" }).disabled).toBe(true);
  expect(screen.getByText(/Protected simulation guidance is unavailable/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Evaluate simulation" })).toBeNull();
});

test("wrapping a selected node creates an exact protected draft command only after readable Apply", async () => {
  await open(); await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Protect node with error handler" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New protected group ID" }), { target: { value: "lookupGroup" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Body success output" }), { target: { value: "Found" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Handled error output" }), { target: { value: "Fallback" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview new protected group" })); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.anything(), { type: "wrapProtected", protectedId: "lookupGroup", nodeIds: ["first"], onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output: { schema: { type: "string" }, success: { kind: "literal", value: "Found" }, handled: { kind: "literal", value: "Fallback" } } }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("handled protected snapshot shows its saved group value without turning the failed lookup into an answer", async () => {
  const saved = protectedRecord(), completedAt = "2026-10-09T02:00:00.000Z"; workflowService.readiness.mockResolvedValue(saved);
  executionService.list.mockResolvedValue([{ id: "protected-run", workflowId: "report", status: "DONE", startedAt: completedAt, workflowSnapshot: { yaml: saved.yaml }, readProgress: { values: { group: { kind: "protect", status: "DONE", completedAt } } }, valueOutputs: { group: { value: "Saved handled answer" } } }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "FAILED" }, { nodeId: "last", status: "DONE" }, { id: "protected_group", nodeId: "group", sideEffect: false, status: "DONE", outcome: "HANDLED_ERROR", completedAt }]);
  await open(); expect(await screen.findByText("Saved handled answer")).toBeTruthy();
  expect(screen.getByText(/original read remains failed/)).toBeTruthy(); expect(screen.getByText(/A declared handler may continue only after/)).toBeTruthy();
  expect(screen.queryByText(/Following nodes were not executed/)).toBeNull();
});

test.each([["BODY_SUCCEEDED", "protected body completed; handler not needed"], ["BODY_ABORTED", "protected body stopped after its recorded failure"]])("protected skipped outcome %s has its own explanation and no answer", async (outcome, explanation) => {
  const saved = protectedRecord(); workflowService.readiness.mockResolvedValue(saved);
  executionService.list.mockResolvedValue([{ id: "skipped-run", workflowId: "report", status: "FAILED", startedAt: "2026-10-09T02:00:00.000Z", workflowSnapshot: { yaml: saved.yaml }, stepOutputs: {} }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "last", status: "SKIPPED", outcome }]);
  await open(); expect(await screen.findByText(new RegExp(`${explanation}.*has no answer`))).toBeTruthy();
  expect(screen.queryByText(/another branch was selected/)).toBeNull(); expect(screen.queryByText(/Node answer/)).toBeNull();
});

test("another snapshot cannot supply a protected group value to the current draft", async () => {
  const saved = protectedRecord(), completedAt = "2026-10-09T02:00:00.000Z"; workflowService.readiness.mockResolvedValue(saved);
  executionService.list.mockResolvedValue([{ id: "old-run", workflowId: "report", status: "DONE", startedAt: completedAt, workflowSnapshot: { yaml }, readProgress: { values: { group: { kind: "protect", status: "DONE", completedAt } } }, valueOutputs: { group: { value: "Stale protected value" } } }]);
  executionService.getTimeline.mockResolvedValue([{ id: "protected_group", nodeId: "group", sideEffect: false, status: "DONE", outcome: "HANDLED_ERROR", completedAt }]);
  await open(); expect(screen.queryByText("Stale protected value")).toBeNull(); expect(screen.getByText("No protected completion recorded for this snapshot")).toBeTruthy();
});

test("reopened workspace undo/redo uses saved server targets instead of remembered client YAML", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, editHistory: { profile: "draft-edit-history/v1", undoTarget: "base-snapshot", redoTarget: "saved-edit" } });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Undo workflow edit" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "undoDraft", versionId: "base-snapshot" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Redo workflow edit" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Redo workflow edit" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenLastCalledWith("report", expect.objectContaining({ version: 1 }), { type: "redoDraft", versionId: "saved-edit" }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("unknown history never enables local undo and read-only users cannot activate undo/redo", async () => {
  const view = await open(); expect(screen.getByRole("button", { name: "Undo workflow edit" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Redo workflow edit" }).disabled).toBe(true);
  view.unmount(); await open({ canEdit: false });
  expect(screen.queryByRole("button", { name: "Undo workflow edit" })).toBeNull(); expect(screen.queryByRole("button", { name: "Redo workflow edit" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit history" })).toBeTruthy();
});

test("selected structural scope stays pending rather than becoming unscoped while a saved edit's readiness refresh is held", async () => {
  const saved = collectionRecord(); let release; const onNodeContext = jest.fn();
  workflowService.readiness.mockResolvedValueOnce(saved).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  workflowService.command.mockResolvedValue({ ...saved, version: 2, editHistory: { undoTarget: "base", redoTarget: null } });
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit onNodeContext={onNodeContext} />); fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum collection items" }), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview collection edit" })); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "each", version: 2, pending: true })));
  expect(screen.getByRole("button", { name: "Undo workflow edit" }).disabled).toBe(true);
  release({ ...saved, version: 2 }); await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "each", version: 2, pending: false })));
});

function collectionRecord() {
  const s = iterationFixture();
  return { ...record, yaml: s.yaml, contentHash: s.sourceHash, authoring: { profile: "read-authoring/v1", controlFlow: s.flow, collections: [{ nodeId: "each", itemSources: [], collectSources: [] }] } };
}

function analysisRecord() {
  const source = `name: Analysed report\ntrigger:\n  type: manual\nsteps:\n - id: first\n   action: demo.echo\n   parameters:\n     value: original\n - id: summary\n   kind: analysis\n   description: Summarise invoices\n   instruction: Return the reviewed total\n   input: '{{first.structuredContent.value}}'\n   data_class: internal\n   model: model-2026-10\n   max_input_items: 20\n   max_input_chars: 5000\n   max_output_tokens: 512\n   output_schema:\n     type: object\n     properties:\n       summary:\n         type: string\n     required: [summary]\n     additionalProperties: false\n - id: deliver\n   action: demo.notify\n   parameters:\n     value: '{{summary.structuredContent.summary}}'\n`;
  return { ...record, yaml: source, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1", authoring: { profile: "read-authoring/v1", nodes: [
    { nodeId: "first", effectClass: "read", dataSources: [] },
    { nodeId: "summary", kind: "analysis", dataSources: [{ label: "Node first · value", expression: "{{first.structuredContent.value}}" }] },
    { nodeId: "deliver", effectClass: "notification", dataSources: [{ label: "Analysis summary · summary", expression: "{{summary.structuredContent.summary}}" }] },
  ] } };
}

function agentRecord() {
  const source = `name: Agent report\ndescription: Bounded dynamic read before delivery\ntrigger:\n  type: manual\nsteps:\n - id: first\n   action: demo.echo\n   parameters:\n     value: original\n - id: research\n   kind: agent\n   description: Research invoices\n   instruction: Gather only the required confirmed evidence\n   input: '{{first.structuredContent.value}}'\n   allowed_actions: [demo.echo]\n   data_class: internal\n   model: model-2026-10\n   max_input_items: 20\n   max_input_chars: 5000\n   max_output_tokens: 512\n   max_total_tokens: 2048\n   max_rounds: 3\n   max_tool_calls: 4\n   max_wall_time_ms: 30000\n   max_concurrency: 1\n   completion_predicate:\n     path: [complete]\n     equals: true\n   output_schema:\n     type: object\n     properties:\n       summary:\n         type: string\n       complete:\n         type: boolean\n     required: [summary, complete]\n     additionalProperties: false\n - id: deliver\n   action: demo.notify\n   parameters:\n     value: '{{research.structuredContent.summary}}'\n`;
  return { ...record, yaml: source, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1", authoring: { profile: "read-authoring/v1", nodes: [
    { nodeId: "first", effectClass: "read", actions: ["demo.echo"], dataSources: [] },
    { nodeId: "research", kind: "agent", actions: ["demo.echo"], dataSources: [{ label: "Node first · value", expression: "{{first.structuredContent.value}}" }] },
    { nodeId: "deliver", effectClass: "notification", actions: ["demo.notify"], dataSources: [{ label: "Agent research · summary", expression: "{{research.structuredContent.summary}}" }] },
  ] } };
}

test("saved model-workflow return is readable beside its node and skipped effect has no answer", async () => {
  const value = analysisRecord(), returned = { kind: "return", id: "answer", output: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "summary", path: ["structuredContent", "summary"] } } };
  value.authoring = { ...value.authoring, returnNodesSupported: true, controlFlow: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }, { kind: "action", nodeId: "summary" }, returned, { kind: "action", nodeId: "deliver" }] } };
  workflowService.readiness.mockResolvedValue(value);
  const savedRun = { id: "returned-run", workflowId: "report", status: "DONE", startedAt: "2026-10-08T00:00:00Z", workflowSnapshot: { version: 1, contentHash: record.contentHash, yaml: value.yaml }, finalOutput: "Reviewed answer",
    readProgress: { attempts: { first: { status: "DONE" }, summary: { status: "DONE" }, deliver: { status: "SKIPPED" } }, values: { answer: { kind: "return", status: "DONE" } } },
    stepOutputs: { first: { structuredContent: { value: "source" } }, summary: { structuredContent: { summary: "Reviewed answer" } } }, valueOutputs: { answer: { value: "Reviewed answer" } } };
  executionService.list.mockResolvedValue([savedRun]); executionService.get.mockResolvedValue(savedRun);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "deliver", status: "SKIPPED", outcome: "AFTER_RETURN", returnId: "answer" }]);
  await open(); expect(await screen.findByText("Saved workflow return · no tool call")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Return answer" })).getByText("Reviewed answer")).toBeTruthy();
  expect(screen.getByText(/workflow returned at answer.*no answer/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select return answer" }));
  expect(screen.getByRole("button", { name: "Preview return edit" })).toBeTruthy();
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
});

test.each([true, false, undefined])("operation return insertion requires explicit server guidance: %s", async supported => {
  const value = analysisRecord(); value.authoring.returnNodesSupported = supported;
  workflowService.readiness.mockResolvedValue(value); await open();
  expect(screen.getByRole("button", { name: "Add return" }).disabled).toBe(supported !== true);
  if (supported === true) {
    fireEvent.click(screen.getByRole("button", { name: "Add return" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New return ID" }), { target: { value: "answer" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Return value" }), { target: { value: "Readable result" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview new return" }));
    expect(workflowService.command).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
    await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), expect.objectContaining({ type: "addReturn", nodeId: "answer", output: { schema: { type: "string" }, value: { kind: "literal", value: "Readable result" } } })));
  }
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
});

test("operation decision canvas shows skipped model/effect evidence and allows scoped model editing without offering unsupported primitives", async () => {
  const saved = analysisRecord(), flow = { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }, { kind: "if", id: "gate",
    predicate: { kind: "literal", value: false }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "summary" }, { kind: "action", nodeId: "deliver" }] },
    else: { kind: "sequence", nodes: [] } }] };
  saved.authoring = { ...saved.authoring, executionProfile: "decision-operation-v1", modelNodesSupported: true, controlFlow: flow, conditions: [{ nodeId: "gate", dataSources: [] }] };
  workflowService.readiness.mockResolvedValue(saved);
  executionService.list.mockResolvedValue([{ id: "decision-model-run", workflowId: "report", status: "DONE", startedAt: "2026-10-08T00:00:00Z",
    workflowSnapshot: { yaml: saved.yaml }, readProgress: { decisions: { gate: { status: "DONE", selected: "else" } } },
    stepOutputs: { first: { structuredContent: { value: "Confirmed source" } } } }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "DONE" }, { nodeId: "summary", status: "SKIPPED" }, { nodeId: "deliver", status: "SKIPPED" }]);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  await screen.findByText("If no · Selected"); expect(screen.getByText(/Governed decision flow/)).toBeTruthy();
  expect(screen.getAllByText(/another branch was selected.*no answer/)).toHaveLength(2);
  expect(screen.queryByText(/Structured analysis answer/)).toBeNull();
  expect(screen.getByRole("button", { name: "Add return" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Summarise invoices/ }));
  expect(screen.getByRole("button", { name: "Wrap node in condition" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Wrap node in collection" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  expect(screen.queryByRole("checkbox", { name: "Declare branch output" })).toBeNull();
  expect(screen.getByText(/Typed branch output is unavailable without current server guidance/)).toBeTruthy();
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("selected analysis node has a typed bounded inspector and applies only an explicit analysis draft command", async () => {
  const saved = analysisRecord(); workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: /Summarise invoices/ }));
  expect(screen.getByRole("complementary", { name: "Selected analysis details" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Analysis input" }).value).toBe("{{first.structuredContent.value}}");
  expect(screen.getByRole("combobox", { name: "Analysis data class" }).value).toBe("internal");
  fireEvent.change(screen.getByRole("textbox", { name: "Analysis instruction" }), { target: { value: "Return one concise reviewed total" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Analysis maximum output tokens" }), { target: { value: "256" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview analysis edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: saved.contentHash }), expect.objectContaining({
    type: "updateAnalysis", nodeId: "summary", patch: expect.objectContaining({ instruction: "Return one concise reviewed total", input: "{{first.structuredContent.value}}", data_class: "internal", model: "model-2026-10", max_output_tokens: 256 }) })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("analysis node chat remains revision-scoped and runtime output is shown as a readable node answer", async () => {
  const saved = analysisRecord(), run = { id: "analysis-run", workflowId: "report", startedAt: "2026-10-07T00:00:00Z", status: "AWAITING_APPROVAL",
    workflowSnapshot: { yaml: saved.yaml, version: 1, executionProfile: "sequential-operation-v1" }, readProgress: { profile: "read-progress-v1", lastSequence: 2 },
    stepOutputs: { summary: { structuredContent: { summary: "Invoices total LKR 125,000", reviewed: true } } } };
  workflowService.readiness.mockResolvedValue(saved); executionService.list.mockResolvedValue([run]); executionService.getTimeline.mockResolvedValue([
    { nodeId: "first", status: "DONE", outcome: "READ_COMPLETED" },
    { nodeId: "summary", status: "DONE", phase: "COMPLETE", outcome: "ANALYSIS_STRUCTURED_OUTPUT" },
    { nodeId: "deliver", status: "AWAITING_APPROVAL", sideEffect: true },
  ]);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: /Summarise invoices/ }));
  expect(screen.getByText("Invoices total LKR 125,000")).toBeTruthy(); expect(screen.getByText("Yes")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Use a shorter summary" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Use a shorter summary", undefined, { nodeContext: { workflowId: "report", nodeId: "summary", baseVersion: 1, baseHash: saved.contentHash } }));
  expect(screen.getByText(/cannot approve egress/)).toBeTruthy();
});

test("operation workspace adds an analysis node as a reviewable positioned draft preview", async () => {
  const saved = analysisRecord(); workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Add analysis" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New analysis ID" }), { target: { value: "classify" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New analysis instruction" }), { target: { value: "Classify the reviewed summary" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New analysis input" }), { target: { value: "{{summary.structuredContent.summary}}" } });
  fireEvent.change(screen.getByRole("combobox", { name: "New analysis position" }), { target: { value: "deliver" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview analysis node" }));
  expect(screen.getByRole("region", { name: "Node change preview" }).textContent).toMatch(/classify.*Main sequence · before deliver/);
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1 }), expect.objectContaining({ type: "addAnalysis", beforeNodeId: "deliver", node: expect.objectContaining({ id: "classify", kind: "analysis", input: "{{summary.structuredContent.summary}}", data_class: "internal" }) })));
});

test("flat read workspace can add model nodes without adding a fake write or publishing automatically", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, executionProfile: "sequential-read-v1", effectProfile: "read-only", authoring: { profile: "read-authoring/v1", modelNodesSupported: true, nodes: ["first", "last"].map(nodeId => ({ nodeId, effectClass: "read", actions: ["demo.echo"] })) } });
  await open(); expect(screen.getByRole("button", { name: "Add bounded agent" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add analysis" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New analysis ID" }), { target: { value: "summarise" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New analysis instruction" }), { target: { value: "Summarise the actual read answer" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New analysis input" }), { target: { value: "{{last.structuredContent.value}}" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview analysis node" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1 }), expect.objectContaining({ type: "addAnalysis", node: expect.objectContaining({ id: "summarise", kind: "analysis" }) })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("selected bounded agent has typed allow-list, completion and budget editing with readable saved output", async () => {
  const saved = agentRecord(), run = { id: "agent-run", workflowId: "report", startedAt: "2026-10-07T00:00:00Z", status: "AWAITING_APPROVAL",
    workflowSnapshot: { yaml: saved.yaml, version: 1, executionProfile: "sequential-operation-v1" }, readProgress: { profile: "read-progress-v1", lastSequence: 5 },
    stepOutputs: { research: { structuredContent: { summary: "Two confirmed invoices", complete: true } } } };
  workflowService.readiness.mockResolvedValue(saved); executionService.list.mockResolvedValue([run]); executionService.getTimeline.mockResolvedValue([
    { nodeId: "first", status: "DONE", outcome: "READ_CONFIRMED" }, { nodeId: "research", status: "DONE", phase: "COMPLETE", outcome: "AGENT_STRUCTURED_OUTPUT" },
    { nodeId: "deliver", status: "AWAITING_APPROVAL", sideEffect: true },
  ]);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: /Research invoices/ }));
  expect(screen.getByRole("complementary", { name: "Selected agent details" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Allow agent action demo.echo" }).checked).toBe(true);
  expect(screen.getByRole("spinbutton", { name: "Agent maximum rounds" }).value).toBe("3");
  expect(screen.getByRole("textbox", { name: "Agent completion path" }).value).toBe("complete");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Agent maximum rounds" }), { target: { value: "2" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Agent maximum tool calls" }), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview agent edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByText("Two confirmed invoices")).toBeTruthy(); expect(screen.getAllByText("Yes").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1 }), expect.objectContaining({
    type: "updateAgent", nodeId: "research", patch: expect.objectContaining({ allowed_actions: ["demo.echo"], completion_predicate: { path: ["complete"], equals: true }, max_rounds: 2, max_tool_calls: 2, max_concurrency: 1 }) })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("operation workspace adds a bounded agent as a positioned reviewable draft", async () => {
  const saved = agentRecord(); workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Add bounded agent" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New agent ID" }), { target: { value: "verify" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New agent instruction" }), { target: { value: "Verify the saved research summary" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New agent input" }), { target: { value: "{{research.structuredContent.summary}}" } });
  fireEvent.change(screen.getByRole("combobox", { name: "New agent position" }), { target: { value: "deliver" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview agent node" }));
  expect(screen.getByRole("region", { name: "Node change preview" }).textContent).toMatch(/verify.*Main sequence · before deliver/);
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1 }), expect.objectContaining({
    type: "addAgent", beforeNodeId: "deliver", node: expect.objectContaining({ id: "verify", kind: "agent", input: "{{research.structuredContent.summary}}",
      allowed_actions: ["demo.echo"], completion_predicate: { path: ["complete"], equals: true }, max_concurrency: 1 }) })));
});

test("selecting a collection owner forwards its exact saved scope to main chat and exposes a mobile focus action", async () => {
  const saved = collectionRecord(), onNodeContext = jest.fn(), onFocusChat = jest.fn(); workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit onNodeContext={onNodeContext} onFocusChat={onFocusChat} />);
  fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "each", label: "Collection each", workflowId: "report", sessionId: "chat", version: 1, contentHash: saved.contentHash })));
  expect(screen.getByText(/This collection is selected in the main chat/)).toBeTruthy(); expect(screen.queryByRole("textbox", { name: "Selected node prompt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit this collection in chat" })); expect(onFocusChat).toHaveBeenCalledTimes(1);
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("standalone collection owner prompt uses the saved async chat node contract without edits or legacy calls", async () => {
  const saved = collectionRecord(); workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Limit this collection to two items" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Limit this collection to two items", undefined, { nodeContext: { workflowId: "report", nodeId: "each", baseVersion: 1, baseHash: saved.contentHash } }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.proposeNode).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("saved collection-owner proposal has a readable preview and applies only its exact partial draft command", async () => {
  const saved = collectionRecord(), change = { ...proposal, nodeId: "each", baseHash: saved.contentHash, before: { maxItems: 3 }, after: { maxItems: 2 }, command: { type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } } };
  workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit savedProposals={[change]} />);
  const preview = await screen.findByRole("region", { name: "Node change preview" });
  expect(preview.querySelector("pre")).toBeNull(); expect(within(preview).getByText("2")).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(within(preview).getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", { version: 1, contentHash: saved.contentHash, proposalId: change.id }, change.command));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("read-only collection selection cannot activate chat edit scope or collection mutation controls", async () => {
  workflowService.readiness.mockResolvedValue(collectionRecord()); const onNodeContext = jest.fn();
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" onNodeContext={onNodeContext} />);
  fireEvent.click(await screen.findByRole("button", { name: "Select collection each" }));
  expect(screen.getByRole("complementary", { name: "Selected collection details" })).toBeTruthy(); expect(onNodeContext).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole("textbox", { name: "Selected node prompt" })).toBeNull(); expect(screen.queryByRole("button", { name: "Preview collection edit" })).toBeNull(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("a collection proposal exposes compiler errors before applying a blocked draft", async () => {
  const saved = collectionRecord(), change = { ...proposal, nodeId: "each", baseHash: saved.contentHash, before: { maxItems: 3 }, after: { maxItems: 2 }, command: { type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } }, validation: { passed: false, errors: ["Collection result each has an unavailable reference"] } };
  workflowService.readiness.mockResolvedValue(saved);
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit savedProposals={[change]} />);
  const preview = await screen.findByRole("region", { name: "Node change preview" });
  expect(within(preview).getByText(/may only be saved as a blocked draft/)).toBeTruthy(); expect(within(preview).getByText("Proposal issues (1)")).toBeTruthy();
  expect(within(preview).getByText("Collection result each has an unavailable reference")).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("matching collection run answers appear separately beside their node and do not change chat edit scope", async () => {
  const s = iterationFixture(), context = jest.fn();
  workflowService.readiness.mockResolvedValue({ ...record, yaml: s.yaml, contentHash: s.sourceHash, authoring: { profile: "read-authoring/v1", controlFlow: s.flow } });
  executionService.list.mockResolvedValue([s.execution]); executionService.get.mockResolvedValue(s.execution); executionService.getTimeline.mockResolvedValue(s.timeline);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [], cursor: 0, lastSequence: 0, hasMore: false, status: "DONE", profile: "read-progress-v1" });
  const view = render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit onNodeContext={context} />);
  const panel = await screen.findByRole("region", { name: "Saved item evidence for lookup" });
  expect(within(panel).getByText("each · item 1 · Read")).toBeTruthy(); expect(within(panel).getByText("each · item 2 · Read")).toBeTruthy();
  fireEvent.click(within(panel).getAllByRole("button", { name: "Saved item answer" })[1]); expect(within(panel).getByText("Answer 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /01 lookup/ })); await waitFor(() => expect(context).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "lookup", version: 1, contentHash: s.sourceHash })));
  expect(view.container.querySelector("section[aria-label='Saved item evidence for lookup'] pre")).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("a collection answer from another source snapshot cannot appear in the current canvas", async () => {
  const s = iterationFixture(); workflowService.readiness.mockResolvedValue({ ...record, yaml: s.yaml + " ", contentHash: s.sourceHash, authoring: { profile: "read-authoring/v1", controlFlow: s.flow } });
  executionService.list.mockResolvedValue([s.execution]); executionService.getTimeline.mockResolvedValue(s.timeline); executionService.get.mockResolvedValue(s.execution);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [], cursor: 0, lastSequence: 0, hasMore: false, status: "DONE", profile: "read-progress-v1" });
  render(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" />); await screen.findByText(/Saved item evidence does not match/);
  expect(screen.queryByRole("button", { name: "Saved item answer" })).toBeNull(); expect(screen.queryByText("Answer 1")).toBeNull(); expect(screen.queryByText("Answer 2")).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("canvas collection wrapping remains preview-only until an explicit revision-bound apply", async () => {
  await open(); await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Wrap node in collection" }));
  fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "each" } }); fireEvent.submit(screen.getByRole("form", { name: "Wrap node in collection" }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), expect.objectContaining({ type: "wrapCollection", nodeId: "first", loopId: "each", maxItems: 25 })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

test("an unacknowledged canvas prompt is retained on remount and is not applied", async () => {
  send.mockResolvedValue(null); const view = await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Keep my pending edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalled()); view.unmount();
  await open(); expect(screen.getByRole("textbox", { name: "Selected node prompt" }).value).toBe("Keep my pending edit");
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.proposeNode).not.toHaveBeenCalled();
});

test("manual editing is preview-only until an explicit revision-bound apply", async () => {
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Node label" }), { target: { value: "Read invoices" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).textContent).toContain("Read invoices");
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "updateNode", nodeId: "first", patch: { description: "Read invoices", action: "demo.echo", parameters: { value: "original" } } }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("a reviewed node connection is selected explicitly and saved in the revision-bound draft command", async () => {
  const connected = { ...record, authoring: { profile: "read-authoring/v1", connectionChoices: [
    { id: "finance", primary: true }, { id: "hr", primary: false },
  ], nodes: [{ nodeId: "first", effectClass: "read", connectionId: "finance", dataSources: [] }] } };
  workflowService.readiness.mockResolvedValue(connected);
  await open(); await selectNode();
  expect(screen.getByRole("combobox", { name: "Node ERPBridge connection" }).value).toBe("finance");
  fireEvent.change(screen.getByRole("combobox", { name: "Node ERPBridge connection" }), { target: { value: "hr" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).textContent).toContain("hr");
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), {
    type: "updateNode", nodeId: "first", patch: { description: "", action: "demo.echo", connection_id: "hr", parameters: { value: "original" } },
  }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("node prompts persist a scoped proposal and stale apply preserves its preview", async () => {
  workflowService.command.mockRejectedValue({ response: { data: { message: "Draft changed. Reload." } } });
  const view = await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Change the value" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Change the value", undefined, { nodeContext: { workflowId: "report", nodeId: "first", baseVersion: 1, baseHash: record.contentHash } }));
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
  expect(workflowService.proposeNode).not.toHaveBeenCalled();
  messages = [{ artifacts: { proposal } }]; view.rerender(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit selectionStorageKey="account.chat" />);
  await screen.findByRole("region", { name: "Node change preview" });
  expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  expect(workflowService.command).toHaveBeenCalledWith("report", { version: 1, contentHash: record.contentHash, proposalId: proposal.id }, proposal.command);
});

test("saved proposals restore after remount and a discarded proposal cannot reappear from stale chat cache", async () => {
  const view = await open({ savedProposals: [proposal] });
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull());
  expect(workflowService.command).toHaveBeenCalledWith("report", record, { type: "discardProposal", proposalId: proposal.id });
  view.rerender(<WorkflowWorkspaceEditor workflowId="report" sessionId="chat" canEdit savedProposals={[proposal]} />);
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
});

test("read-only users see source and run status, never editing or proposal actions", async () => {
  await open({ canEdit: false, savedProposals: [proposal] }); await selectNode();
  expect(screen.queryByRole("textbox", { name: "Node label" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply to draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Publish reviewed draft" })).toBeNull();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
});

test("publication is explicit and does not call execution", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Publish reviewed draft" }));
  await waitFor(() => expect(workflowService.publish).toHaveBeenCalledWith("report", "Explicitly reviewed in chat workspace", record));
  expect(workflowService.run).not.toHaveBeenCalled();
});

test.each([500, 502, 503, 504])("HTTP %s edit acknowledgement uncertainty blocks repeat Apply until an authoritative reload", async status => {
  workflowService.command.mockRejectedValueOnce({ response: { status, data: { message: "Upstream unavailable" } } });
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Node label" }), { target: { value: "Keep this pending label" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByText("Edit save outcome is unconfirmed. Reload authoritative storage before editing again. No automatic retry was sent.");
  expect(screen.getByRole("region", { name: "Node change preview" }).textContent).toContain("Keep this pending label");
  expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Publish reviewed draft" }).disabled).toBe(true);
  expect(workflowService.command).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload workflow" }));
  await screen.findByText("Authoritative draft reloaded. Review the current revision before another edit.");
  expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(false);
  expect(workflowService.command).toHaveBeenCalledTimes(1);
});

test.each(["manual", "saved model"])("publication waits for the %s preview to be applied or discarded", async kind => {
  await open(kind === "saved model" ? { savedProposals: [proposal] } : {});
  if (kind === "manual") { await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" })); }
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Publish reviewed draft" }).disabled).toBe(true);
  expect(screen.getByText("Apply or discard the pending change before publishing. Publishing uses the saved draft only.")).toBeTruthy();
  expect(workflowService.publish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish reviewed draft" }).disabled).toBe(false));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("a failed run retrieves actual partial node outputs and does not silently publish", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, bridge: "discovery_available" });
  workflowService.run.mockRejectedValue({ response: { data: { message: "Second node failed", meta: { executionId: "run-failed" } } } });
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "DONE" }, { nodeId: "last", status: "FAILED" }]);
  await open(); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  fireEvent.click(await screen.findByText("Node answer · run run-failed"));
  expect(screen.getByText(/real answer/)).toBeTruthy();
  expect(screen.getByText("Value")).toBeTruthy();
  expect(screen.getByText("Node answer · run run-failed").parentElement.querySelector("pre")).toBeNull();
  expect(executionService.get).toHaveBeenCalledWith("run-failed");
  expect(workflowService.publish).not.toHaveBeenCalled();
});

test("known failed-node response is readable beside the node and is not called a successful answer", async () => {
  executionService.list.mockResolvedValue([{ id: "run-failure", workflowId: "report", startedAt: "2026-10-05T00:00:00Z", status: "FAILED", workflowSnapshot: { yaml }, stepOutputs: {} }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "FAILED", output: { content: [{ type: "text", text: "Rate limit reached" }], isError: true, _meta: { "com.erpbridge/error": { type: "rate_limit", retryable: true } } } }]);
  await open(); fireEvent.click(await screen.findByText("Node failure response · run run-failure"));
  expect(screen.getByText("The tool reported an error.")).toBeTruthy(); expect(screen.getByText("Rate limit reached")).toBeTruthy();
  expect(screen.queryByText("Node answer · run run-failure")).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("a save acknowledgement survives a readiness refresh failure and blocks further publication", async () => {
  workflowService.readiness.mockResolvedValueOnce(record).mockRejectedValue(new Error("Offline"));
  await open(); await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByText("Draft saved, but readiness could not be refreshed. Reload before publishing or running.");
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
  expect(screen.getByRole("button", { name: "Publish reviewed draft" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
});

test("friendly parameter fields produce the same revision-bound command without a JSON editor", async () => {
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Parameters · value" }), { target: { value: "manager report" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), expect.objectContaining({ patch: { description: "", action: "demo.echo", parameters: { value: "manager report" } } })));
});

test("friendly run input fields submit typed values only through explicit Run", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, bridge: "discovery_available" });
  await open();
  fireEvent.change(screen.getByRole("textbox", { name: "Run inputs new field name" }), { target: { value: "limit" } });
  fireEvent.click(screen.getByRole("button", { name: "Add field" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Run inputs · limit value type" }), { target: { value: "number" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Run inputs · limit" }), { target: { value: "5" } });
  expect(workflowService.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await waitFor(() => expect(workflowService.run).toHaveBeenCalledWith("report", { limit: 5 }));
  expect(workflowService.publish).not.toHaveBeenCalled();
});

test("a synchronous run request does not lock draft/node editing or send a second run", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true });
  let finish;
  workflowService.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await open(); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText(/synchronous endpoint has not returned its run identifier/);
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  await selectNode();
  expect(screen.getByRole("button", { name: "Preview manual edit" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  expect(workflowService.run).toHaveBeenCalledTimes(1);
  finish({ id: "run-one", status: "DONE", stepOutputs: {} });
  await waitFor(() => expect(screen.queryByText(/synchronous endpoint has not returned/)).toBeNull());
});

test("an unconfirmed run response blocks repeat dispatch and directs the user to history", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true });
  workflowService.run.mockRejectedValue(new Error("Network Error"));
  await open(); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByRole("link", { name: /Review execution history/ });
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(workflowService.run).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/No automatic retry was sent/)).toBeTruthy();
});

test("recovered runs show readable saved answers and unknown nodes, never a fresh run action", async () => {
  const interrupted = { id: "run-recovery", workflowId: "report", status: "RECOVERY_REQUIRED", startedAt: "2026-10-05T00:00:00Z", workflowSnapshot: { yaml, version: 1 }, readProgress: { profile: "read-progress-v1", lastSequence: 1 }, stepOutputs: { first: { structuredContent: { value: "retained answer" } } } };
  executionService.list.mockResolvedValue([interrupted]); executionService.get.mockResolvedValue(interrupted);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "DONE" }, { nodeId: "last", status: "UNKNOWN" }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: interrupted.id, sequence: 1, timestamp: interrupted.startedAt, type: "node.outcome_unknown", nodeId: "last" }], cursor: 1, lastSequence: 1, hasMore: false, status: interrupted.status, profile: "read-progress-v1" });
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true });
  await open({ canControl: true });
  await screen.findByText(/Outcome unknown · the read may have reached ERP/);
  fireEvent.click(screen.getByText("Node answer · run run-recovery"));
  expect(screen.getByText("retained answer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Request cancellation" })).toBeNull();
});

test("async-ready workspace admits once, receives the run ID and starts monitoring saved queued state", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, read_job_admission: "read-job-v1" });
  const admitted = { id: "run-queued", status: "PENDING", readProgress: { profile: "read-progress-v1", lastSequence: 1 }, workflowSnapshot: { yaml, version: 1 }, stepOutputs: {} };
  workflowService.run.mockResolvedValue(admitted); executionService.get.mockResolvedValue(admitted);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: admitted.id, sequence: 1, timestamp: "2026-10-05T00:00:00Z", type: "run.queued" }], cursor: 1, lastSequence: 1, hasMore: false, status: "PENDING", profile: "read-progress-v1" });
  await open({ canControl: true }); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText("Read job queued");
  expect(workflowService.run).toHaveBeenCalledWith("report", {}, expect.objectContaining({ mode: "async-read", idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }));
  expect(screen.getByRole("button", { name: "Request cancellation" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(workflowService.run).toHaveBeenCalledTimes(1);
});

test("operation-ready workspace uses separate admission and continues managing an exact approval wait", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1" });
  const admitted = { id: "operation-wait", status: "AWAITING_APPROVAL", readProgress: { profile: "read-progress-v1", lastSequence: 1 }, workflowSnapshot: { yaml, version: 1, executionProfile: "sequential-operation-v1" }, stepOutputs: {} };
  workflowService.run.mockResolvedValue(admitted); executionService.get.mockResolvedValue(admitted);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "AWAITING_APPROVAL", sideEffect: true }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: admitted.id, sequence: 1, timestamp: "2026-10-06T00:00:00Z", type: "approval.requested" }], cursor: 1, lastSequence: 1, hasMore: false, status: admitted.status, profile: "read-progress-v1" });
  await open({ canControl: true }); fireEvent.click(screen.getByRole("button", { name: "Run published version" }));
  await screen.findByText("Exact operation approval requested");
  expect(workflowService.run).toHaveBeenCalledWith("report", {}, expect.objectContaining({ mode: "async-operation", idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }));
  expect(screen.getByText(/this operation has not been dispatched/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Request cancellation" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
  expect(workflowService.run).toHaveBeenCalledTimes(1);
});

test("an uncertain operation node explains possible ERP effects and cannot start another run", async () => {
  const interrupted = { id: "operation-unknown", workflowId: "report", status: "RECONCILIATION_REQUIRED", startedAt: "2026-10-06T00:00:00Z", workflowSnapshot: { yaml, version: 1, executionProfile: "sequential-operation-v1" }, readProgress: { profile: "read-progress-v1", lastSequence: 1 }, stepOutputs: {} };
  executionService.list.mockResolvedValue([interrupted]); executionService.get.mockResolvedValue(interrupted);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "UNKNOWN", sideEffect: true }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: interrupted.id, sequence: 1, timestamp: interrupted.startedAt, type: "node.outcome_unknown", nodeId: "first" }], cursor: 1, lastSequence: 1, hasMore: false, status: interrupted.status, profile: "read-progress-v1" });
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1" });
  await open({ canControl: true }); await screen.findByText(/operation may have taken effect in ERP/);
  expect(screen.queryByText(/the read may have reached ERP/)).toBeNull();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true); expect(workflowService.run).not.toHaveBeenCalled();
});

test("operator-closed canvas retains external evidence beside the unknown node without fabricating a tool answer or rerun", async () => {
  const closed = { id: "operation-closed", workflowId: "report", status: "RECONCILED", hasOperationReconciliation: true, startedAt: "2026-10-06T00:00:00Z", workflowSnapshot: { yaml, version: 1, executionProfile: "sequential-operation-v1" }, readProgress: { profile: "read-progress-v1", lastSequence: 1 }, stepOutputs: {} };
  executionService.list.mockResolvedValue([closed]); executionService.get.mockResolvedValue(closed);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "UNKNOWN", sideEffect: true, reconciliation: { id: "evidence", outcome: "APPLIED", basis: "operator-attestation", actorId: "operator", recordedAt: closed.startedAt, evidence: { reference: "ERP-123", note: "Inspected external record", kind: "erp-record", observedAt: closed.startedAt } } }]);
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [{ version: 1, executionId: closed.id, sequence: 1, timestamp: closed.startedAt, type: "operation.reconciliation_recorded", nodeId: "first", payload: { outcome: "APPLIED" } }], cursor: 1, lastSequence: 1, hasMore: false, status: closed.status, profile: "read-progress-v1" });
  workflowService.readiness.mockResolvedValue({ ...record, published: true, can_attempt_run: true, executionProfile: "sequential-operation-v1", operation_job_admission: "operation-job/v1" });
  await open({ canControl: true }); await screen.findByText("Effect observed · operator attestation");
  // The optional collapsed YAML source is not the business-evidence display.
  expect(screen.getByText("ERP-123")).toBeTruthy(); expect(screen.getByText(/Not a saved tool answer/)).toBeTruthy(); expect(screen.getByLabelText("Operator evidence").querySelector("pre")).toBeNull();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true); expect(screen.queryByText(/Node answer/)).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
  expect(await screen.findByRole("region", { name: "ERP status queries" })).toBeTruthy();
});

test("matching uncertain canvas shows saved status observation beside its source node without producing a node answer", async () => {
  const run = { id: "query-run", workflowId: "report", status: "RECONCILIATION_REQUIRED", hasOperationReconciliation: true, workflowSnapshot: { yaml, version: 1, executionProfile: "sequential-operation-v1" }, stepOutputs: {} };
  executionService.list.mockResolvedValue([run]); executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "UNKNOWN", sideEffect: true }]);
  const history = statusHistory(); history.executionId = run.id; history.nodeId = "first"; history.jobs[0] = { ...history.jobs[0], executionId: run.id, nodeId: "first" };
  operationReadbackService.history.mockResolvedValue(history); const submit = jest.spyOn(operationReadbackService, "admit").mockResolvedValue({ ...history.jobs[0], replayed: true });
  await open(); const region = await screen.findByRole("region", { name: "ERP status queries" }); await within(region).findByText("Not-applied condition observed");
  expect(region.closest("li").querySelector("button").textContent).toMatch(/first/); expect(screen.queryByText(/Node answer/)).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Query current ERP state" })); await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0]).toEqual({ executionId: run.id, intentId: history.intentId, nodeId: "first" }); expect(workflowService.run).not.toHaveBeenCalled();
});

test("a changed draft does not attach historical query observations to its current node", async () => {
  const run = { id: "older-query-run", workflowId: "report", status: "RECONCILIATION_REQUIRED", hasOperationReconciliation: true, workflowSnapshot: { yaml: `${yaml}# old snapshot`, version: 1, executionProfile: "sequential-operation-v1" }, stepOutputs: {} };
  executionService.list.mockResolvedValue([run]); executionService.getTimeline.mockResolvedValue([{ nodeId: "first", status: "UNKNOWN", sideEffect: true }]);
  await open(); const region = await screen.findByRole("region", { name: "ERP status queries" });
  expect(region.closest("li")).toBeNull(); expect(screen.getByText(/different or unverified run snapshot/)).toBeTruthy();
});

test("schema guidance selects readable data and applies only the reviewed revision-bound draft", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [{ nodeId: "first", actions: ["demo.echo"], inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, dataSources: [{ expression: "{{input.report}}", label: "Workflow input · report", schema: { type: "string" } }] }] } });
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("combobox", { name: "Parameters · value input mode" }), { target: { value: "data" } });
  expect(screen.getByRole("combobox", { name: "Parameters · value data source" }).textContent).toContain("Workflow input · report · string");
  fireEvent.click(screen.getByRole("button", { name: "Preview manual edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "updateNode", nodeId: "first", patch: { description: "", action: "demo.echo", parameters: { value: "{{input.report}}" } } }));
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
});

test("changing the tool never applies the former tool schema or erases old parameters", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [{ nodeId: "first", actions: ["demo.echo"], inputSchema: { type: "object", properties: { value: { type: "string" } } }, dataSources: [] }] } });
  await open(); await selectNode();
  fireEvent.change(screen.getByRole("textbox", { name: "Node tool" }), { target: { value: "unknown.tool" } });
  expect(screen.getByText(/No current supported schema guidance for this tool/)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Parameters · value" }).value).toBe("original");
  expect(workflowService.command).not.toHaveBeenCalled();
});

test("stale compiled publication can explicitly republish instead of leaving the workspace unable to repair it", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, compilation: { state: "BLOCKED" } });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Republish reviewed draft" }));
  await waitFor(() => expect(workflowService.publish).toHaveBeenCalledWith("report", "Explicitly reviewed in chat workspace", expect.objectContaining({ version: 1, contentHash: record.contentHash })));
  expect(workflowService.run).not.toHaveBeenCalled();
});

test("compiler and publication readiness reasons are visible and not hidden behind successful original validation", async () => {
  workflowService.readiness.mockResolvedValue({ ...record, published: true, compilation: { state: "BLOCKED" }, issues: ["Published execution artifact needs current capability review and explicit re-publication"] });
  await open();
  expect(screen.getByText("Execution readiness issues (1)")).toBeTruthy();
  expect(screen.getByText(/Published execution artifact needs current capability review/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run published version" }).disabled).toBe(true);
});

test("workspace renders confirmed branch scopes, selectable action nodes and truthful skipped-node status", async () => {
  const flow = { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] } }] };
  workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [], controlFlow: flow } });
  executionService.list.mockResolvedValue([{ id: "branch-run", workflowId: "report", startedAt: "2026-10-05T00:00:00Z", status: "DONE", workflowSnapshot: { yaml }, readProgress: { decisions: { gate: { status: "DONE", selected: "then" } } }, stepOutputs: { first: { structuredContent: { value: "selected answer" } } } }]);
  executionService.getTimeline.mockResolvedValue([{ nodeId: "gate", status: "DONE", outcome: "CONDITION_SELECTED" }, { nodeId: "first", status: "DONE" }, { nodeId: "last", status: "SKIPPED" }]);
  await open(); await screen.findByText("If yes · Selected");
  expect(screen.getByText(/another branch was selected.*no answer/)).toBeTruthy(); fireEvent.click(screen.getByText("Node answer · run branch-run")); expect(screen.getByText("selected answer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /first ERP step/ })); expect(screen.getByRole("textbox", { name: "Node label" })).toBeTruthy();
  expect(workflowService.run).not.toHaveBeenCalled();
});

const conditionFlow = { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] } }] };
function showConditions(extra = {}) { workflowService.readiness.mockResolvedValue({ ...record, authoring: { profile: "read-authoring/v1", nodes: [], controlFlow: conditionFlow, conditions: [{ nodeId: "gate", dataSources: [] }] }, ...extra }); }

test("return selection scopes chat and previews a false output without saving or executing", async () => {
  const output = { schema: { type: "boolean" }, value: { kind: "literal", value: true } }, flow = JSON.parse(JSON.stringify(conditionFlow));
  flow.nodes.push({ kind: "return", id: "answer", output });
  showConditions({ authoring: { profile: "read-authoring/v1", controlFlow: flow, returns: [{ nodeId: "answer", dataSources: [] }] } });
  const onNodeContext = jest.fn(); await open({ onNodeContext }); fireEvent.click(screen.getByRole("button", { name: "Select return answer" }));
  expect(screen.getByText(/Scheduled returns do not activate a schedule, approve an effect or prove delivery/)).toBeTruthy();
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "answer", version: 1, contentHash: record.contentHash })));
  fireEvent.change(screen.getByRole("combobox", { name: "Return value" }), { target: { value: "false" } }); fireEvent.click(screen.getByRole("button", { name: "Preview return edit" }));
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "updateReturn", nodeId: "answer", patch: { output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } } }));
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
});

test("branch merge and new return require explicit reviewed commands", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" })); fireEvent.click(screen.getByRole("checkbox", { name: "Declare branch output" }));
  fireEvent.change(screen.getByRole("textbox", { name: "If yes output" }), { target: { value: "yes value" } }); fireEvent.change(screen.getByRole("textbox", { name: "If no output" }), { target: { value: "no value" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview branch output edit" })); expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "setConditionMerge", nodeId: "gate", merge: { schema: { type: "string" }, then: { kind: "literal", value: "yes value" }, else: { kind: "literal", value: "no value" } } }));
});

const operationBranchFlow = () => ({ kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }, { kind: "if", id: "gate",
  predicate: { kind: "literal", value: false }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "summary" }, { kind: "action", nodeId: "deliver" }] }, else: { kind: "sequence", nodes: [] } }] });
test.each([true, false, undefined])("operation branch output editor requires current server support=%s and only saves on Apply", async supported => {
  const saved = analysisRecord(); saved.authoring = { ...saved.authoring, executionProfile: "decision-operation-v1", mergeNodesSupported: supported, controlFlow: operationBranchFlow(),
    conditions: [{ nodeId: "gate", dataSources: [], mergeSources: { then: [], else: [] } }] };
  workflowService.readiness.mockResolvedValue(saved); await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  expect(screen.getByText(/Calendar joins require complete reports on every continuing path/)).toBeTruthy();
  expect(screen.getByText(/Selected invoice keys may pass through a typed branch output to a later related-order read/)).toBeTruthy();
  expect(screen.getByText(/not invented or model-generated keys/)).toBeTruthy();
  expect(screen.getByText(/keys alone are not report content/)).toBeTruthy();
  expect(screen.getByText(/If No means no delivery, end that path before any shared send/)).toBeTruthy();
  if (!supported) { expect(screen.queryByRole("checkbox", { name: "Declare branch output" })).toBeNull(); expect(screen.getByText(/unavailable without current server guidance/)).toBeTruthy(); }
  else {
    fireEvent.click(screen.getByRole("checkbox", { name: "Declare branch output" }));
    fireEvent.change(screen.getByRole("textbox", { name: "If yes output" }), { target: { value: "Reviewed Yes output" } });
    fireEvent.change(screen.getByRole("textbox", { name: "If no output" }), { target: { value: "Reviewed No output" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview branch output edit" })); expect(workflowService.command).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
    await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "setConditionMerge", nodeId: "gate", merge: { schema: { type: "string" }, then: { kind: "literal", value: "Reviewed Yes output" }, else: { kind: "literal", value: "Reviewed No output" } } }));
  }
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("operation canvas shows the exact committed typed branch value beside its recorded decision", async () => {
  const saved = analysisRecord(), flow = operationBranchFlow(); flow.nodes[1].merge = { schema: { type: "integer" }, then: { kind: "literal", value: 8 }, else: { kind: "literal", value: 0 } };
  saved.authoring = { ...saved.authoring, controlFlow: flow, mergeNodesSupported: true, conditions: [{ nodeId: "gate", dataSources: [] }] };
  workflowService.readiness.mockResolvedValue(saved); executionService.list.mockResolvedValue([{ id: "merged-run", workflowId: "report", status: "DONE", startedAt: "2026-10-08T00:00:00Z", workflowSnapshot: { yaml: saved.yaml },
    readProgress: { decisions: { gate: { status: "DONE", selected: "else" } }, values: { gate: { kind: "merge", status: "DONE" } } }, valueOutputs: { gate: { value: 0 } } }]);
  await open(); expect(await screen.findByText("Saved selected-branch value · no tool call")).toBeTruthy();
  expect(screen.getByText("If no · Selected")).toBeTruthy(); expect(within(screen.getByRole("region", { name: "Condition gate" })).getByText("0")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Condition gate" }).querySelector("pre")).toBeNull();
});

test("a new return preserves its explicit destination in a readable preview", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Add return" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New return ID" }), { target: { value: "answer" } }); fireEvent.change(screen.getByRole("combobox", { name: "New return destination" }), { target: { value: "gate:then" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Return value" }), { target: { value: "Explicit output" } }); fireEvent.click(screen.getByRole("button", { name: "Preview new return" }));
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "addReturn", nodeId: "answer", beforeNodeId: null, destination: { conditionId: "gate", branch: "then" }, output: { schema: { type: "string" }, value: { kind: "literal", value: "Explicit output" } } }));
});

test("condition selection forwards stable revision-bound scope to main chat and manual edits stay previews", async () => {
  showConditions(); const onNodeContext = jest.fn(); await open({ onNodeContext });
  fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  await waitFor(() => expect(onNodeContext).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "gate", workflowId: "report", version: 1, contentHash: record.contentHash })));
  fireEvent.change(screen.getByRole("combobox", { name: "Condition value" }), { target: { value: "false" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview condition edit" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash }), { type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("condition prompts use the saved asynchronous node scope and do not call tools or the legacy proposal route", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Selected node prompt" }), { target: { value: "Select yes only when enabled" } });
  fireEvent.click(screen.getByRole("button", { name: "Propose change" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("Select yes only when enabled", undefined, { nodeContext: { workflowId: "report", nodeId: "gate", baseVersion: 1, baseHash: record.contentHash } }));
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.proposeNode).not.toHaveBeenCalled();
});

test.each([false, true])("reopened selected-condition chat output preview requires exact Apply and fences stale revision=%s", async stale => {
  showConditions(); const selected = conditionFlow.nodes[0], merge = { schema: { type: "string" }, then: { kind: "literal", value: "Reviewed Yes result" }, else: { kind: "literal", value: "Reviewed No result" } };
  const change = { ...proposal, nodeId: "gate", before: selected, after: { ...selected, merge }, baseVersion: stale ? 0 : 1, command: { type: "updateCondition", nodeId: "gate", patch: { merge } }, validation: { passed: true } };
  await open({ savedProposals: [change], onNodeContext: jest.fn() }); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  expect(screen.getByText(/Request a condition or typed branch-output change/)).toBeTruthy();
  if (stale) {
    expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply to draft" })).toBeNull();
    expect(workflowService.command).not.toHaveBeenCalled(); return;
  }
  const preview = screen.getByRole("region", { name: "Node change preview" }); expect(within(preview).getByText("Reviewed Yes result")).toBeTruthy(); expect(within(preview).getByText("Reviewed No result")).toBeTruthy();
  expect(preview.querySelector("pre")).toBeNull(); expect(workflowService.command).not.toHaveBeenCalled();
  const apply = within(preview).getByRole("button", { name: "Apply to draft" }); expect(apply.disabled).toBe(stale);
  fireEvent.click(apply);
  if (stale) expect(workflowService.command).not.toHaveBeenCalled();
  else await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", expect.objectContaining({ version: 1, contentHash: record.contentHash, proposalId: change.id }), change.command));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("adding an action into an explicit branch submits its destination instead of a detached flat declaration", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Add node" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New node ID" }), { target: { value: "more" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New node tool" }), { target: { value: "demo.echo" } });
  fireEvent.change(screen.getByRole("combobox", { name: "New node destination" }), { target: { value: "gate:else" } });
  fireEvent.click(screen.getByRole("button", { name: "Add draft node" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByText(/Local preview only · not saved to the database/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "addNode", node: { id: "more", action: "demo.echo", parameters: {} }, beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } }));
});

test("discarding a local added-node preview does not save, publish or run anything", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Add node" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New node ID" }), { target: { value: "local" } });
  fireEvent.change(screen.getByRole("textbox", { name: "New node tool" }), { target: { value: "demo.echo" } });
  fireEvent.click(screen.getByRole("button", { name: "Add draft node" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull());
  expect(workflowService.command).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});
const recordExpect = () => expect.objectContaining({ version: 1, contentHash: record.contentHash });

test("moving an action selects a named branch scope and keeps the action ID", async () => {
  showConditions(); await open(); await selectNode();
  fireEvent.change(screen.getByRole("combobox", { name: "Move node destination" }), { target: { value: "gate:else" } });
  fireEvent.click(screen.getByRole("button", { name: "Move to selected scope end" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByText(/references and prerequisites may need repair/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "moveNode", nodeId: "first", beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } }));
});

test("direct canvas placement is preview-only, revision-bound and available by keyboard-friendly buttons", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" }));
  fireEvent.click(screen.getByRole("button", { name: "Move last" }));
  fireEvent.click(screen.getByRole("button", { name: "Place last · Main sequence · before first" }));
  expect(workflowService.command).not.toHaveBeenCalled();
  const view = screen.getByRole("region", { name: "Node change preview" }); expect(view.querySelector("pre")).toBeNull();
  expect(within(view).getByText("Main sequence · before first")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "moveNode", nodeId: "last", beforeNodeId: "first" }));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("whole-condition canvas moves preserve both paths in the preview and disable all own-descendant positions", async () => {
  const flow = JSON.parse(JSON.stringify(conditionFlow)); flow.nodes.push({ kind: "return", id: "answer", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  showConditions({ authoring: { profile: "read-authoring/v1", controlFlow: flow } }); await open();
  fireEvent.click(screen.getByRole("button", { name: "Arrange flow" })); fireEvent.click(screen.getByRole("button", { name: "Move Condition gate" }));
  expect(screen.getByRole("button", { name: "Place gate · Main sequence → gate · If yes · end" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Place gate · Main sequence · before Return answer" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Place gate · Main sequence · end" }));
  expect(screen.getAllByText("Included in move")).toHaveLength(3);
  expect(screen.getByRole("region", { name: "gate If yes" })).toBeTruthy(); expect(screen.getByRole("region", { name: "gate If no" })).toBeTruthy();
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "moveNode", nodeId: "gate", beforeNodeId: null }));
});

test.each(["action", "if", "return"])("insert %s at a visible branch-before-action point requires explicit preview/apply", async kind => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" }));
  fireEvent.click(screen.getByRole("button", { name: "Insert step · Main sequence → gate · If no · before last" }));
  const form = screen.getByRole("form", { name: "Insert canvas step" });
  fireEvent.change(within(form).getByRole("combobox", { name: "Canvas step type" }), { target: { value: kind } });
  fireEvent.change(within(form).getByRole("textbox", { name: "Canvas step ID" }), { target: { value: "inserted" } });
  if (kind === "action") fireEvent.change(within(form).getByRole("textbox", { name: "Canvas step tool" }), { target: { value: "demo.echo" } });
  fireEvent.submit(form); expect(workflowService.command).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Node change preview" }).querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), expect.objectContaining({ type: kind === "action" ? "addNode" : kind === "if" ? "addCondition" : "addReturn", beforeNodeId: "last", destination: { conditionId: "gate", branch: "else" } })));
  expect(workflowService.publish).not.toHaveBeenCalled(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("foreign/stale drag payload cannot create a proposal; matching revision drag remains preview-only", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" }));
  const data = new Map(), dataTransfer = { setData: (key, value) => data.set(key, value), getData: key => data.get(key) || "", effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(screen.getByRole("button", { name: "Move last" }), { dataTransfer });
  const target = screen.getByRole("listitem", { name: "Insertion point · Main sequence · before first" });
  const exact = data.get("application/x-workflow-node");
  for (const bad of ["{}", "not JSON", JSON.stringify({ ...JSON.parse(exact), workflowId: "other" }), JSON.stringify({ ...JSON.parse(exact), baseVersion: 0 }), "x".repeat(1025)]) {
    data.set("application/x-workflow-node", bad); fireEvent.drop(target, { dataTransfer }); expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
  }
  data.set("application/x-workflow-node", exact); fireEvent.drop(target, { dataTransfer });
  expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("read-only and unconfirmed structural views expose no canvas mutations or invented editable chain", async () => {
  const view = await open({ canEdit: false }); expect(screen.queryByRole("button", { name: "Arrange flow" })).toBeNull(); view.unmount();
  workflowService.readiness.mockResolvedValue({ ...record, yaml: yaml + "metadata:\n  controlFlow:\n    schemaVersion: unknown\n" });
  await open(); expect(screen.getByRole("button", { name: "Arrange flow" }).disabled).toBe(true);
  expect(screen.getByText(/not a confirmed execution layout/)).toBeTruthy(); expect(screen.queryByRole("button", { name: /^Insert step/ })).toBeNull();
});

test.each([undefined, { data: { meta: { code: "DRAFT_SAVE_UNCONFIRMED" }, message: "Unconfirmed" } }])("unconfirmed save %j fences further edits, retains preview and requires authoritative reload", async response => {
  workflowService.command.mockRejectedValueOnce({ response, message: "Lost response" }); await open(); await selectNode();
  fireEvent.click(screen.getByRole("button", { name: "Move to end" })); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByText(/Edit save outcome is unconfirmed/); expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Arrange flow" }).disabled).toBe(true); expect(workflowService.command).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload workflow" })); await waitFor(() => expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(false));
  expect(workflowService.command).toHaveBeenCalledTimes(1);
});

test("reloading a changed revision clears old placement context and retains a stale preview without enabling apply", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "Arrange flow" })); fireEvent.click(screen.getByRole("button", { name: "Move last" }));
  fireEvent.click(screen.getByRole("button", { name: "Place last · Main sequence · before first" }));
  workflowService.readiness.mockResolvedValue({ ...record, version: 2, contentHash: `sha256:${"b".repeat(64)}` });
  fireEvent.click(screen.getByRole("button", { name: "Reload workflow" }));
  await screen.findByText(/This preview belongs to an older draft/);
  expect(screen.getByRole("button", { name: "Apply to draft" }).disabled).toBe(true); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Move last" }).disabled).toBe(false));
  expect(screen.queryByRole("button", { name: /^Place last/ })).toBeNull();
});

test("wrapping an action requires a reviewed preview before saving its explicit branch meaning", async () => {
  await open(); await selectNode(); fireEvent.click(screen.getByRole("button", { name: "Wrap node in condition" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New condition ID" }), { target: { value: "newGate" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Condition value" }), { target: { value: "true" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Wrapped node branch" }), { target: { value: "else" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview new condition" })); expect(workflowService.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "wrapNode", nodeId: "first", conditionId: "newGate", predicate: { kind: "literal", value: true }, branch: "else" }));
});

test("empty condition creation is previewed with readable scope rather than raw source", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New condition ID" }), { target: { value: "inner" } });
  fireEvent.change(screen.getByRole("combobox", { name: "New condition destination" }), { target: { value: "gate:then" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview new condition" }));
  expect(within(screen.getByRole("region", { name: "Node change preview" })).getByText(/gate · If yes.*empty paths/)).toBeTruthy();
  expect(workflowService.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalledWith("report", recordExpect(), { type: "addCondition", conditionId: "inner", predicate: { kind: "literal", value: false }, beforeNodeId: null, destination: { conditionId: "gate", branch: "then" } }));
});

test("nonempty conditions cannot be removed or silently flattened", async () => {
  showConditions(); await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  expect(screen.getByRole("button", { name: "Remove empty condition…" }).disabled).toBe(true);
  expect(screen.getByText(/Nothing is silently flattened/)).toBeTruthy(); expect(workflowService.command).not.toHaveBeenCalled();
});

test("read-only condition inspection exposes no predicate form or mutation controls", async () => {
  showConditions(); await open({ canEdit: false }); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  expect(screen.getByRole("complementary", { name: "Selected condition details" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Condition value" })).toBeNull(); expect(screen.queryByRole("button", { name: "Add condition" })).toBeNull();
});

test("stale condition apply retains the exact unapplied predicate proposal", async () => {
  showConditions(); workflowService.command.mockRejectedValue({ response: { data: { message: "Draft changed. Reload." } } });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Select condition gate" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Condition value" }), { target: { value: "false" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview condition edit" })); fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await screen.findByRole("alert"); expect(screen.getByRole("region", { name: "Node change preview" })).toBeTruthy();
  expect(workflowService.command).toHaveBeenCalledTimes(1); expect(workflowService.run).not.toHaveBeenCalled();
});
