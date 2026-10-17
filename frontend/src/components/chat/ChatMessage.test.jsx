/** @jest-environment jsdom */
import React from "react";
import { test, expect, afterEach, jest } from "@jest/globals";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ChatWorkspaceContext } from "./ChatWorkspaceContext";
jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
const { default: ChatMessage } = await import("./ChatMessage");
afterEach(cleanup);

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

test("a saved workflow opens in the current workspace canvas without navigating to workflow details", () => {
  const openWorkflow = jest.fn();
  render(<MemoryRouter><ChatWorkspaceContext.Provider value={{ openWorkflow }}><ChatMessage message={{ role: "assistant", text: "Draft saved", artifacts: { intent: "WORKFLOW", workflowId: "saved", yaml: "name: Saved\nsteps: []" } }} /></ChatWorkspaceContext.Provider></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Open in canvas" })); expect(openWorkflow).toHaveBeenCalledWith("saved");
});
