/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const sendMessage = jest.fn();
const useAuth = jest.fn(() => ({ user: { id: "owner" } }));
jest.unstable_mockModule("../../services/chat.service", () => ({ chatService: { sendMessage } }));
jest.unstable_mockModule("../../hooks/useAuth", () => ({ useAuth }));
const { default: EmailDraftPreview } = await import("./EmailDraftPreview");
const draft = { profile: "email-draft-v1", id: "draft-1", sessionId: "chat-1", ownerId: "owner", version: 1, contentHash: "sha256:" + "a".repeat(64),
  to: "manager@example.test", subject: "Invoice report", body: "Confirmed fixture report for review.", state: "DRAFT_NOT_SENT", reportStatus: "PREPARED_FOR_REVIEW", recurring: false,
  sourceEvidence: [{ toolName: "read", outputDigest: "sha256:fixture", index: 0 }], requirements: ["Confirm sharing permission before sending."] };
afterEach(() => { cleanup(); sendMessage.mockReset(); useAuth.mockReturnValue({ user: { id: "owner" } }); });

test("readable recipient/subject/body and not-sent state never offer Send or raw JSON", () => {
  render(<EmailDraftPreview draft={draft} />);
  expect(screen.getByLabelText("Recipient email").value).toBe("manager@example.test");
  expect(screen.getByLabelText("Message draft").value).toBe(draft.body);
  expect(screen.getByText("Not sent · revision 1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^send/i })).toBeNull();
  expect(screen.queryByText(/sha256:/)).toBeNull();
  fireEvent.click(screen.getByText("Before sending · 1 confirmed reads"));
  expect(screen.getByText("Confirm sharing permission before sending.")).toBeTruthy();
});
test("a confirmed save updates revision, retains not-sent state, and carries only a bound edit", async () => {
  const saved = { ...draft, version: 2, body: "Reviewed facts", reportStatus: "USER_EDITED" };
  sendMessage.mockResolvedValue({ assistantMessage: { artifacts: { emailDraft: saved } } });
  render(<EmailDraftPreview draft={draft} />);
  fireEvent.change(screen.getByLabelText("Message draft"), { target: { value: "Reviewed facts" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Draft changes saved. Nothing sent or approved."));
  expect(screen.getByText("Not sent · revision 2")).toBeTruthy();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0][0]).toBe("chat-1");
  expect(sendMessage.mock.calls[0][2].emailDraftCommand).toMatchObject({ draftId: draft.id, baseVersion: 1, baseHash: draft.contentHash, patch: { to: draft.to, subject: draft.subject, body: "Reviewed facts" } });
  expect(sendMessage.mock.calls[0][2].emailDraftCommand.commandId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
});
test.each(["conflict", "network", "server", "bad-confirmation"])("%s keeps the user's edit and locks uncertain/stale saving until reload", async (scenario) => {
  if (scenario === "bad-confirmation") sendMessage.mockResolvedValue({ assistantMessage: { artifacts: { emailDraft: { ...draft, state: "SENT", version: 2 } } } });
  else sendMessage.mockRejectedValue(scenario === "network" ? new Error("timeout") : { response: { status: scenario === "conflict" ? 409 : 503 } });
  render(<EmailDraftPreview draft={draft} />);
  fireEvent.change(screen.getByLabelText("Message draft"), { target: { value: "My unsaved changes" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Reload/));
  expect(screen.getByLabelText("Message draft").value).toBe("My unsaved changes");
  expect(screen.getByRole("button", { name: "Save draft changes" }).disabled).toBe(true);
  expect(screen.getByText("Not sent · revision 1")).toBeTruthy();
});
test("other-account viewer gets no editor actions", () => {
  useAuth.mockReturnValue({ user: { id: "other" } });
  render(<EmailDraftPreview draft={draft} />);
  expect(screen.queryByRole("button", { name: "Save draft changes" })).toBeNull(); expect(screen.getByLabelText("Recipient email").disabled).toBe(true);
});
test("superseded history is read-only even for the owner", () => {
  render(<EmailDraftPreview draft={draft} superseded />);
  expect(screen.queryByRole("button", { name: "Save draft changes" })).toBeNull();
  expect(screen.getByText(/Historical draft/)).toBeTruthy();
});
test("confirmed save followed by failed refresh is not mislabeled as failed persistence", async () => {
  sendMessage.mockResolvedValue({ assistantMessage: { artifacts: { emailDraft: { ...draft, version: 2 } } } });
  render(<EmailDraftPreview draft={draft} onSaved={async () => { throw new Error("refresh failed"); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Conversation refresh failed"));
  expect(screen.getByText("Not sent · revision 2")).toBeTruthy();
});
test("exact saved draft requests independent approval without claiming dispatch or delivery", async () => {
  const receipt = { profile: "email-delivery-admission/v1", admissionId: "admission-1", workflowId: "workflow-1", executionId: "execution-1",
    draftId: draft.id, draftVersion: draft.version, draftHash: draft.contentHash, status: "PENDING", reviewRequested: true,
    freshIndependentApprovalRequired: true, bridgeDispatched: false, deliveryVerified: false };
  sendMessage.mockResolvedValue({ emailDelivery: receipt });
  render(<EmailDraftPreview draft={draft} />);
  const request = screen.getByRole("button", { name: "Request independent approval" }); expect(request.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I confirm this exact recipient/)); expect(request.disabled).toBe(false); fireEvent.click(request);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Nothing has been sent"));
  expect(screen.getByText(/Approval requested · not sent/)).toBeTruthy(); expect(screen.getByText("Independent review requested. No delivery is verified.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open governed execution" }).getAttribute("href")).toBe("/executions/execution-1");
  expect(screen.queryByRole("button", { name: "Save draft changes" })).toBeNull();
  expect(sendMessage.mock.calls[0][2].emailDeliveryCommand).toMatchObject({ profile: "email-delivery-admission-command/v1", draftId: draft.id,
    baseVersion: draft.version, baseHash: draft.contentHash, sharingConfirmed: true });
  expect(sendMessage.mock.calls[0][2].emailDeliveryCommand).not.toHaveProperty("tool");
  expect(sendMessage.mock.calls[0][2].emailDeliveryCommand).not.toHaveProperty("arguments");
});
test("uncertain approval acknowledgement locks resubmission until reload", async () => {
  sendMessage.mockRejectedValue(new Error("network")); render(<EmailDraftPreview draft={draft} />);
  fireEvent.click(screen.getByLabelText(/I confirm this exact recipient/)); fireEvent.click(screen.getByRole("button", { name: "Request independent approval" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/uncertain/i));
  expect(screen.getByRole("button", { name: "Request independent approval" }).disabled).toBe(true);
});
test("offline recurring draft explains missing reads and never implies an active schedule", () => {
  render(<EmailDraftPreview draft={{ ...draft, reportStatus: "NOT_PREPARED", body: "", recurring: true, sourceEvidence: [] }} reportReason="ERPBRIDGE_NOT_CONNECTED" />);
  expect(screen.getByText("ERPBridge is not connected. No report was retrieved.")).toBeTruthy();
  expect(screen.getByText("Report not prepared · no schedule active")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Request independent approval" })).toBeNull();
  expect(screen.getByText(/must be created and reviewed as a scheduled workflow/)).toBeTruthy();
});
test("directory recipient resolution is rendered as readable provenance, not raw JSON", () => {
  render(<EmailDraftPreview draft={{ ...draft, recipientReference: "my manager", recipientResolution: { profile: "recipient-directory-resolution/v1", requestedLabel: "my manager", status: "RESOLVED", source: "DIRECT_MANAGER", userId: "manager", userName: "Maya Perera", email: "manager@example.test", reason: "Resolved from the requester's assigned active manager." } }} />);
  expect(screen.getByText(/Recipient resolved from the company directory: Maya Perera/)).toBeTruthy();
  expect(screen.queryByText(/recipient-directory-resolution\/v1/)).toBeNull();
});

test("an incomplete saved draft can continue through the normal chat agent without sending or requesting approval", async () => {
  let acknowledge;
  const onContinue = jest.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  render(<EmailDraftPreview draft={{ ...draft, originalRequest: "get the orders and email them", body: "", reportStatus: "NOT_PREPARED" }} onContinue={onContinue} />);
  const button = screen.getByRole("button", { name: "Prepare email with assistant" });
  fireEvent.click(button); fireEvent.click(button);
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onContinue.mock.calls[0][0]).toContain("get the orders");
  expect(onContinue.mock.calls[0][0]).toContain("current recipient manager@example.test");
  expect(onContinue.mock.calls[0][0]).toContain("Do not send it yet");
  expect(screen.getByRole("button", { name: "Preparing in chat…" }).disabled).toBe(true);
  expect(screen.getByLabelText("Message draft").disabled).toBe(true);
  acknowledge({ operation: { id: "chat-operation", status: "QUEUED" } });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Preparation requested in chat"));
  expect(sendMessage).not.toHaveBeenCalled();
});

test("unsaved edits or an active chat block email preparation, while historical and foreign drafts offer no recovery action", () => {
  const onContinue = jest.fn();
  const view = render(<EmailDraftPreview draft={draft} onContinue={onContinue} />);
  fireEvent.change(screen.getByLabelText("Recipient email"), { target: { value: "other@example.test" } });
  expect(screen.getByRole("button", { name: "Prepare email with assistant" }).disabled).toBe(true);
  view.rerender(<EmailDraftPreview draft={draft} onContinue={onContinue} busy />);
  expect(screen.getByRole("button", { name: "Prepare email with assistant" }).disabled).toBe(true);
  view.rerender(<EmailDraftPreview draft={draft} onContinue={onContinue} superseded />);
  expect(screen.queryByRole("button", { name: "Prepare email with assistant" })).toBeNull();
  expect(onContinue).not.toHaveBeenCalled();
});

test("unconfirmed preparation locks repeats and preserves the draft", async () => {
  const onContinue = jest.fn(async () => null);
  render(<EmailDraftPreview draft={draft} onContinue={onContinue} />);
  fireEvent.click(screen.getByRole("button", { name: "Prepare email with assistant" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("acknowledgement is unconfirmed"));
  expect(screen.getByRole("button", { name: "Prepare email with assistant" }).disabled).toBe(true);
  expect(screen.getByLabelText("Message draft").value).toBe(draft.body);
  expect(sendMessage).not.toHaveBeenCalled();
});
