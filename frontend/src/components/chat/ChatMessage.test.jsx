/** @jest-environment jsdom */
import React from "react";
import { test, expect, afterEach, jest } from "@jest/globals";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChatWorkspaceContext } from "./ChatWorkspaceContext";
jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
const { default: ChatMessage } = await import("./ChatMessage");

test("a saved workflow opens in the current workspace canvas without navigating to workflow details", () => {
  const openWorkflow = jest.fn();
  render(<MemoryRouter><ChatWorkspaceContext.Provider value={{ openWorkflow }}><ChatMessage message={{ role: "assistant", text: "Draft saved", artifacts: { intent: "WORKFLOW", workflowId: "saved", yaml: "name: Saved\nsteps: []" } }} /></ChatWorkspaceContext.Provider></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Open in canvas" })); expect(openWorkflow).toHaveBeenCalledWith("saved");
});
afterEach(() => { cleanup(); localStorage.clear(); });

test("an incomplete saved workflow offers clear in-place completion and requirements controls, never an OK approval", () => {
  const openWorkflow = jest.fn(), openCanvasTools = jest.fn(), focusChat = jest.fn();
  render(<MemoryRouter><ChatWorkspaceContext.Provider value={{ openWorkflow, openCanvasTools, focusChat }}><ChatMessage message={{ role: "assistant", text: "Draft saved", artifacts: {
    intent: "WORKFLOW", workflowId: "unfinished", yaml: "name: Unfinished\nsteps: []\nmetadata:\n  unresolved_requirements:\n    - Confirm the reporting timezone\n", validation: { passed: false },
  } }} /></ChatWorkspaceContext.Provider></MemoryRouter>);
  expect(screen.getByRole("region", { name: "Complete workflow draft" }).textContent).toContain("no approval to confirm");
  fireEvent.click(screen.getByRole("button", { name: "Complete in chat" }));
  expect(openWorkflow).toHaveBeenCalledWith("unfinished"); expect(focusChat).toHaveBeenCalledTimes(1); expect(openCanvasTools).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review draft requirements" })); expect(openCanvasTools).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: /^(OK|Approve|Confirm and execute)$/ })).toBeNull();
});

test("busy or read-only incomplete workflow guidance cannot change selection or focus", () => {
  const openWorkflow = jest.fn(), focusChat = jest.fn();
  render(<MemoryRouter><ChatWorkspaceContext.Provider value={{ openWorkflow, focusChat }}><ChatMessage busy message={{ role: "assistant", text: "Saved", artifacts: { intent: "WORKFLOW", workflowId: "unfinished", yaml: "name: Empty\nsteps: []" } }} /></ChatWorkspaceContext.Provider></MemoryRouter>);
  const button = screen.getByRole("button", { name: "Complete in chat" }); expect(button.disabled).toBe(true); fireEvent.click(button);
  expect(openWorkflow).not.toHaveBeenCalled(); expect(focusChat).not.toHaveBeenCalled();
});

test("a valid nonempty workflow does not show incomplete-draft guidance", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Saved", artifacts: { intent: "WORKFLOW", workflowId: "saved", yaml: "name: Saved\nsteps:\n  - {id: read, action: get_company}\n", validation: { passed: true } } }} /></MemoryRouter>);
  expect(screen.queryByRole("region", { name: "Complete workflow draft" })).toBeNull();
});

test("whole-workflow proposal opens the existing canvas review controls without importing or executing a duplicate", () => {
  const openWorkflow = jest.fn(), openCanvasTools = jest.fn();
  render(<MemoryRouter><ChatWorkspaceContext.Provider value={{ openWorkflow, openCanvasTools }}><ChatMessage message={{ role: "assistant", text: "I've prepared the requested change.", artifacts: {
    intent: "WORKFLOW_PATCH_PROPOSAL", workflowId: "saved", proposal: { id: "proposal", scope: "workflow", workflowId: "saved", status: "PROPOSED", summary: "Show the directory here.", before: { name: "Directory" }, after: { name: "Directory" }, validation: { passed: true } },
  } }} /></ChatWorkspaceContext.Provider></MemoryRouter>);
  expect(screen.getByRole("region", { name: "Workflow change review" })).toBeTruthy();
  expect(screen.getByText("Proposed · saved draft unchanged")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review and apply in canvas" }));
  expect(openWorkflow).toHaveBeenCalledWith("saved"); expect(openCanvasTools).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Generated YAML")).toBeNull(); expect(screen.queryByText("Pass to Canvas")).toBeNull();
});

test.each(["APPLIED", "DISCARDED"])("a resolved whole-workflow %s proposal never offers Apply again", status => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Recorded change review", artifacts: { intent: "WORKFLOW_PATCH_PROPOSAL", proposal: {
    scope: "workflow", workflowId: "saved", status, appliedVersion: 2, summary: "Requested change", validation: { passed: true },
  } } }} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "Review and apply in canvas" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain(status === "APPLIED" ? "not published or run" : "unchanged");
});

test("saved-workflow run handoff opens review controls and does not claim execution", () => {
  const openWorkflow = jest.fn(), openCanvasTools = jest.fn();
  render(<MemoryRouter><ChatWorkspaceContext.Provider value={{ openWorkflow, openCanvasTools }}><ChatMessage message={{ role: "assistant", text: "Review the saved workflow before starting.", artifacts: {
    intent: "WORKFLOW_CONTROL", workflowControl: { profile: "workflow-control-handoff/v1", action: "run", workflowId: "saved", name: "Directory" },
  } }} /></ChatWorkspaceContext.Provider></MemoryRouter>);
  expect(screen.getByRole("status").textContent).toContain("no command executed");
  fireEvent.click(screen.getByRole("button", { name: "Review run in canvas" }));
  expect(openWorkflow).toHaveBeenCalledWith("saved"); expect(openCanvasTools).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Generated YAML")).toBeNull();
});

test.each([true, false])("missing ERP reads shows truthful recovery based on current review permission (%s)", canManageErpAccess => {
  render(<MemoryRouter><ChatMessage canManageErpAccess={canManageErpAccess} message={{ role: "assistant", text: "No read tool is available.", artifacts: {
    code: "NO_APPROVED_READ_TOOLS", toolsDispatched: false,
    accessRecovery: { profile: "erp-read-access-recovery/v1", canReview: true, automaticGrant: false },
  } }} /></MemoryRouter>);
  expect(screen.getByRole("note", { name: "ERP tool access" }).textContent).toContain("ERP request not run");
  expect(Boolean(screen.queryByRole("button", { name: "Review ERP tool access" }))).toBe(canManageErpAccess);
  expect(screen.queryByText("Generated YAML")).toBeNull();
});

test("administrator ERP access recovery opens the existing review page, not an automatic approval", () => {
  render(<MemoryRouter><Routes><Route path="/" element={<ChatMessage canManageErpAccess message={{ role: "assistant", text: "Review required", artifacts: { code: "NO_APPROVED_READ_TOOLS" } }} />} />
    <Route path="/registry/tools" element={<p>Current ERP tool review page</p>} /></Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Review ERP tool access" }));
  expect(screen.getByText("Current ERP tool review page")).toBeTruthy();
});

test.each([true, false])("a stored-document retrieval blocker offers contract review only to an administrator (%s)", canManageErpAccess => {
  render(<MemoryRouter><ChatMessage canManageErpAccess={canManageErpAccess} message={{ role: "assistant", text: "Document retrieval needs review.", artifacts: { intent: "WORKFLOW_ERROR", code: "DOCUMENT_BRIDGE_REVIEW_REQUIRED", can_execute: false } }} /></MemoryRouter>);
  expect(screen.getByRole("note", { name: "Document retrieval access" }).textContent).toContain("Document stored");
  expect(Boolean(screen.queryByRole("button", { name: "Review ERP document access" }))).toBe(canManageErpAccess);
  expect(screen.queryByRole("button", { name: /^(OK|Approve|Confirm and execute)$/ })).toBeNull(); expect(screen.queryByText("Generated YAML")).toBeNull();
});

test("same-chat recall is labelled as historical context, not a fresh ERP result or workflow change", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Your earlier question was about invoices.", artifacts: {
    intent: "CONVERSATION", conversationRecall: { profile: "chat-history-recall/v1", messageIds: ["earlier"] }, toolsDispatched: false,
  } }} /></MemoryRouter>);
  expect(screen.getByText(/Earlier messages recalled from this conversation/)).toBeTruthy();
  expect(screen.queryByText(/Saved tool responses/)).toBeNull(); expect(screen.queryByText("Generated YAML")).toBeNull();
});

test("conversation and workflow explanations have a normal assistant presentation without fake read results or workflow mutations", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "This workflow checks the company directory and pages through units of measure.", artifacts: {
    intent: "WORKFLOW_DISCUSSION", discussion: { profile: "workflow-discussion/v1", draftVersion: 1 }, toolsDispatched: false,
  } }} /></MemoryRouter>);
  expect(screen.getByRole("status").textContent).toBe("Workflow explanation · draft v1 · Explanation only");
  expect(screen.queryByText(/No confirmed ERP data/)).toBeNull();
  expect(screen.queryByText(/Saved tool responses/)).toBeNull(); expect(screen.queryByRole("button", { name: "Open Workflow" })).toBeNull();
});

test.each([true, false])("input correction feedback is distinct from ERP execution (requested=%s)", correctionRequested => {
  const { container } = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Read result.", artifacts: { intent: "QUERY",
    proposalCorrections: [{ toolName: "directory_lookup", reason: "ARGUMENT_SCHEMA", status: "NOT_DISPATCHED", correctionRequested }],
    toolSteps: [{ toolName: "directory_lookup", arguments: { recipients: ["a@example.test"] }, status: "SUCCEEDED", result: [{ email: "a@example.test" }] }],
  } }} /></MemoryRouter>);
  expect(screen.getByRole("region", { name: "Tool input checks" }).textContent).toContain("These proposals were not sent to ERPBridge");
  expect(screen.getByText(correctionRequested ? "Tool input correction requested" : "Tool input correction stopped")).toBeTruthy();
  expect(screen.getByText(/Confirmed read response/)).toBeTruthy();
  expect(container.textContent).not.toMatch(/\bpi\b/i);
  expect(container.textContent).not.toContain("[object Object]");
});

test.each(["saved-report", undefined])("historical YAML %s cannot offer an unscoped save from another workflow's cached handoff", workflowId => {
  localStorage.setItem("workflow.pendingChatEdit", JSON.stringify({ workflowId: "unrelated", workflowName: "Other workflow" }));
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Saved historical answer", artifacts: { intent: "WORKFLOW", ...(workflowId ? { workflowId } : {}), yaml: "name: Historical\nsteps: []", validation: { passed: true } } }} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "Save Changes", exact: true })).toBeNull();
  if (workflowId) expect(screen.getByRole("button", { name: "Open Workflow", exact: true })).toBeTruthy();
});

test.each([
  ["deny", "LOCAL_POLICY_RESPONSE_INVALID", "Check failed"], ["deny", "LOCAL_POLICY_PROVIDER_FAILED", "Check failed"],
  ["deny", undefined, "Denied"], ["review", undefined, "Needs review"],
])("policy %s with failure %s shows truthful status %s", (decision, failureCode, label) => {
  const { container } = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Request stopped.", artifacts: { intent: "POLICY_DENIAL", policyCheck: {
    source: "local_model", decision, failureCode, reason: "Nothing was approved.",
  } } }} /></MemoryRouter>);
  expect(screen.getByRole("status").textContent).toBe(`Policy check · Local JSON / model · ${label}`);
  expect(container.querySelector("pre")).toBeNull(); expect(container.textContent).not.toContain("LOCAL_POLICY_");
});

test("policy decision is readable, identifies local fallback and never renders raw JSON", () => {
  const { container } = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Request reviewed.", artifacts: { policyCheck: {
    source: "local_model", decision: "allow", fallbackUsed: true, reason: "Read-only request is permitted.", policyVersion: "1.0.0",
  } } }} /></MemoryRouter>);
  expect(screen.getByRole("status").textContent).toBe("Policy check · Local JSON / model · Allowed · Fallback used");
  expect(screen.getByText("Read-only request is permitted.")).toBeTruthy(); expect(container.querySelector("pre")).toBeNull();
});

test("backup model is disclosed as routing metadata, not a fabricated ERP result", () => {
  const { container } = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Confirmed invoice read.", artifacts: {
    intent: "QUERY", modelRouting: { requestedModel: "primary", model: "backup", fallbackUsed: true },
  } }} /></MemoryRouter>);
  expect(screen.getByRole("status").textContent).toBe("Answered with backup model · backup");
  expect(container.querySelector("pre")).toBeNull();
  expect(container.textContent).not.toMatch(/Email sent|ERP change made|primary.*succeeded/);
});

test("normal selected-model answers do not show a backup notice", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Read answer.", artifacts: {
    intent: "QUERY", modelRouting: { requestedModel: "primary", model: "primary", fallbackUsed: false },
  } }} /></MemoryRouter>);
  expect(screen.queryByText(/Answered with backup model/)).toBeNull();
});

test.each(["PROPOSED", "APPLIED", "DISCARDED"])("protected chat %s exposes readable mappings without claiming they are run answers", status => {
  const output = { schema: { type: "string" }, success: { kind: "literal", value: "Explicit body mapping" }, handled: { kind: "ref", source: "nodeOutput", nodeId: "guard", path: ["error", "code"] } };
  const proposal = { nodeId: "guard", status, appliedVersion: 2, before: { output }, after: { output, body: { nodes: [{ nodeId: "unrelated_body" }] } }, command: { type: "updateProtected", nodeId: "guard", patch: { output } } };
  const view = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Node change proposed.", artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal } }} /></MemoryRouter>);
  expect(screen.getByText("Review protected output mappings")).toBeTruthy(); expect(screen.getAllByText("Node guard → error → code")).toHaveLength(2);
  expect(screen.getByText(/These are mappings, not run answers/)).toBeTruthy(); expect(view.container.querySelector("pre")).toBeNull(); expect(view.container.textContent).not.toContain("unrelated_body");
  if (status === "APPLIED") expect(screen.getByText(/Applied to draft v2/)).toBeTruthy();
  if (status === "DISCARDED") expect(screen.getByText(/Proposal discarded/)).toBeTruthy();
});
test("chat shows the persisted proposal decision rather than only stale proposed wording", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Node change proposed.", artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal: { nodeId: "invoices", status: "APPLIED", appliedVersion: 2 } } }} /></MemoryRouter>);
  expect(screen.getByText("Applied to draft v2 · not published or executed by this decision.")).toBeTruthy();
});
test("validated saved workflow is explicitly a draft, not invalid or ready to execute", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Saved.", artifacts: { intent: "WORKFLOW", workflowId: "one", yaml: "name: one\nsteps: []", validation: { passed: true }, can_execute: false } }} /></MemoryRouter>);
  expect(screen.getByText("Saved draft · Validation passed")).toBeTruthy();
  expect(screen.queryByText(/ready to execute/)).toBeNull();
});
test("recurring workflow shows readable missing requirements and never claims an active schedule", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Recurring automation draft saved.", artifacts: { intent: "WORKFLOW", yaml: "name: Daily\ntrigger:\n  type: manual\nsteps: []", can_execute: false,
    automationRequest: { profile: "recurring-delivery-request/v1", cadence: "daily", channel: "email", requestedAddresses: ["manager@example.test"], scheduleActive: false,
      requirements: ["Confirm the delivery time and IANA timezone."] } } }} /></MemoryRouter>);
  expect(screen.getByRole("region", { name: "Recurring automation requirements" }).textContent).toContain("Daily automation· Setup required · no schedule active");
  expect(screen.getByText(/Confirm the delivery time and IANA timezone/)).toBeTruthy();
});
test("recurring workflow presents mapped capabilities as readable draft evidence", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Recurring workflow steps saved.", artifacts: { intent: "WORKFLOW", yaml: "name: Daily\ntrigger:\n  type: manual\nsteps: []", can_execute: false,
    automationRequest: { profile: "recurring-delivery-request/v1", cadence: "daily", channel: "email", requestedAddresses: ["manager@example.test"], scheduleActive: false },
    automationComposition: { profile: "recurring-automation-composition/v1", status: "PARTIAL", mappedSteps: [
      { stepId: "invoice_report", capability: "report", resource: "invoices", tool: "erp.invoices" }, { stepId: "send_report", capability: "delivery", tool: "erp.email" },
    ], remainingRequirements: ["Confirm delivery time and timezone."], scheduleActive: false } } }} /></MemoryRouter>);
  const region = screen.getByRole("region", { name: "Recurring automation requirements" });
  expect(region.textContent).toContain("Draft composed · no schedule active");
  expect(region.textContent).toContain("invoice_report · invoices · erp.invoices");
  expect(region.textContent).toContain("send_report · erp.email");
  expect(screen.getByText("Confirm delivery time and timezone.")).toBeTruthy();
});
test("incomplete read preparation is not mislabeled as a successful result or a known timeout", () => {
  render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Preparation stopped.", artifacts: { intent: "QUERY", sources: [{ name: "read", arguments: {} }], boundHit: true } }} /></MemoryRouter>);
  expect(screen.getByText("1 tool call · preparation incomplete")).toBeTruthy();
  expect(screen.queryByText(/limit reached/)).toBeNull();
});

test.each(["MAPPED", "UNRESOLVED"])("recurring analysis %s is readable draft evidence, not an answer or delivery claim", (status) => {
  const { container } = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Workflow draft saved.", artifacts: {
    intent: "WORKFLOW", yaml: "name: Daily\ntrigger:\n  type: manual\nsteps: []", can_execute: false,
    automationRequest: { profile: "recurring-delivery-request/v1", cadence: "daily", channel: "email", requestedAddresses: ["manager@example.test"], analysisRequested: true },
    automationComposition: { profile: "recurring-automation-composition/v1", status: "PARTIAL", analysis: { status }, mappedSteps: [
      { stepId: "invoice_analysis", capability: "analysis", resource: "invoices", tool: "Bounded analysis", sourceStepId: "invoice_report" },
    ], remainingRequirements: ["Confirm delivery time and timezone."], scheduleActive: false },
  } }} /></MemoryRouter>);
  const region = screen.getByRole("region", { name: "Recurring automation requirements" });
  expect(region.textContent).toContain(status === "MAPPED" ? "Analysis mapped for each requested report · not executed" : "Requested report analysis still needs setup");
  expect(region.textContent).toContain("invoice_analysis · invoices · Bounded analysis · from invoice_report");
  expect(region.textContent).toContain("no schedule active"); expect(container.querySelector("pre")).toBeNull();
  expect(region.textContent).not.toMatch(/CAPABILITIES_MAPPED|structuredContent|Email sent|Schedule activated/);
});
test("historical chat exposes saved structured/attachment/failure receipts even without an active operation monitor", () => {
  const { container } = render(<MemoryRouter><ChatMessage message={{ role: "assistant", text: "Partial read.", artifacts: { intent: "QUERY", toolSteps: [
    { toolName: "invoices", status: "SUCCEEDED", result: { content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], structuredContent: { invoice_id: "INV-7" } } },
    { toolName: "details", status: "FAILED", result: { content: [{ type: "text", text: "Rate limit reached" }], isError: true } },
  ] } }} /></MemoryRouter>);
  expect(screen.getByText("Saved tool responses · 2")).toBeTruthy(); expect(screen.getByText("Invoice id")).toBeTruthy(); expect(screen.getByText("INV-7")).toBeTruthy();
  expect(screen.getByText("details · Failure response")).toBeTruthy(); expect(screen.getByText("Rate limit reached")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show image attachment" })).toBeTruthy(); expect(container.querySelector("img,pre")).toBeNull();
});
