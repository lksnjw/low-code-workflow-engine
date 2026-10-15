/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
const user = { id: "admin", role: "Platform Admin" };
const get = jest.fn(), execute = jest.fn(), current = jest.fn(() => true);
jest.unstable_mockModule("../../hooks/useAuth", () => ({ useAuth: () => ({ user }) }));
jest.unstable_mockModule("../../utils/authAuthority", () => ({ captureAuthority: () => ({}), isAuthorityCurrent: current }));
jest.unstable_mockModule("../../services/chat-erp-actions.service", () => ({ chatErpActionsService: { get, execute } }));
const { default: Card } = await import("./ChatErpActionCard");
const action = { profile: "erp-chat-action/v1", id: "action", ownerId: "admin", sessionId: "chat", toolName: "create_item", arguments: { item_code: "QA-1" }, reviewHash: "a".repeat(64), status: "PENDING" };
afterEach(() => { cleanup(); get.mockReset(); execute.mockReset(); current.mockReturnValue(true); user.id = "admin"; user.role = "Platform Admin"; });
async function review() {
  get.mockResolvedValue(action); fireEvent.click(screen.getByRole("button", { name: "Review current action" }));
  await screen.findByRole("checkbox");
}
test("history renders no background action GET and no executable control until a current review", () => {
  render(<Card action={action} />); expect(get).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Create item" })).toBeTruthy();
  expect(screen.getByText("Technical details").closest("details").open).toBe(false);
  expect(screen.queryByRole("button", { name: "Confirm and execute" })).toBeNull();
});

test("record updates show business fields while retaining the exact technical contract separately", () => {
  render(<Card action={{ ...action, toolName: "update_document", arguments: { doctype: "Customer", name: "QA-1", fieldname: '{"customer_details":"Reviewed description"}' } }} />);
  expect(screen.getByRole("heading", { name: "Update customer" })).toBeTruthy();
  const technical = screen.getByText("Technical details").closest("details");
  expect(technical.textContent).toContain("update_document"); expect(technical.textContent).toContain('{"customer_details":"Reviewed description"}');
  expect(technical.open).toBe(false); expect(execute).not.toHaveBeenCalled();
});
test("exact fields require explicit confirmation, with loading and single dispatch on double click", async () => {
  let done; execute.mockImplementation(() => new Promise(resolve => { done = resolve; })); const saved = jest.fn();
  render(<Card action={action} onSaved={saved} />); await review();
  expect(screen.getByRole("button", { name: "Confirm and execute" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Confirm and execute" }));
  fireEvent.click(screen.getByRole("button", { name: "Executing ERP change…" })); expect(execute).toHaveBeenCalledTimes(1);
  done({ ...action, status: "SUCCEEDED", receipt: { content: [], structuredContent: { name: "QA-1" } } });
  await screen.findByText("ERP response received"); expect(saved).toHaveBeenCalledTimes(1); expect(screen.queryByRole("checkbox")).toBeNull();
});
test("lost write response offers only read-only refresh; even PENDING cannot re-enable Retry", async () => {
  execute.mockRejectedValue(new Error("network")); render(<Card action={action} />); await review();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Confirm and execute" }));
  await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "Refresh action status" }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2)); expect(screen.queryByRole("button", { name: "Confirm and execute" })).toBeNull(); expect(execute).toHaveBeenCalledTimes(1);
});
test("another role/owner cannot review or self-confirm an administrator action", () => {
  user.id = "other"; user.role = "Workflow Builder"; render(<Card action={action} />);
  expect(screen.queryByRole("button")).toBeNull(); expect(screen.getByText(/Only the requesting administrator/)).toBeTruthy();
});

test("email uses clear Review and Send controls but still requires fresh exact confirmation and dispatches only once", async () => {
  const email = { ...action, toolName: "send_email", arguments: { to: ["recipient@example.test"], subject: "Orders", body: "Reviewed order details" } };
  get.mockResolvedValue(email); execute.mockResolvedValue({ ...email, status: "SUCCEEDED", receipt: { structuredContent: { accepted: true } } });
  render(<Card action={email} />);
  expect(screen.getByRole("heading", { name: "Send email" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Confirm and send email" }).disabled).toBe(true);
  expect(screen.getByRole("checkbox").disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Review email" }));
  const approval = await screen.findByRole("checkbox", { name: "I approve this exact recipient and email message." });
  const send = screen.getByRole("button", { name: "Confirm and send email" }); expect(send.disabled).toBe(true);
  expect(execute).not.toHaveBeenCalled(); fireEvent.click(approval); fireEvent.click(send);
  await screen.findByText("ERP response received"); expect(execute).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Confirm and send email" })).toBeNull();
  expect(screen.queryByText(/delivered successfully/i)).toBeNull();
});

test("outgoing HTML does not flood the review card and remains inspectable under Technical details", () => {
  const html = "<html><body><h1>Order report</h1></body></html>";
  render(<Card action={{ ...action, toolName: "resend-email-send", arguments: { to: ["recipient@example.test"], subject: "Orders", text: "Order report", html } }} />);
  expect(screen.getByText(/HTML email included/)).toBeTruthy();
  const technical = screen.getByText("Technical details").closest("details");
  expect(technical.open).toBe(false); expect(technical.textContent).toContain(html);
  expect(screen.getAllByText(html)).toHaveLength(1); expect(execute).not.toHaveBeenCalled();
});

test("the hosted provider-qualified email tool has the same clear controls and keeps replay keys in technical details", async () => {
  const email = { ...action, toolName: "resend-email-send", arguments: { from: "support@example.test", to: ["recipient@example.test"], subject: "Orders", text: "Reviewed order details", idempotency_key: "private-replay-identity" } };
  get.mockResolvedValue(email); render(<Card action={email} />);
  expect(screen.getByRole("heading", { name: "Send email" })).toBeTruthy();
  const technical = screen.getByText("Technical details").closest("details");
  expect(technical.textContent).toContain("private-replay-identity");
  expect(screen.getAllByText("Reviewed order details").some(element => element.closest("details") === null)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Review email" }));
  await screen.findByRole("button", { name: "Confirm and send email" });
  expect(execute).not.toHaveBeenCalled();
});
test("stale authority cannot display fetched action data or submit a change", async () => {
  render(<Card action={action} />); current.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Review current action" })); expect(get).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

test("an expired proposal explains why confirmation is unavailable beside its fields", async () => {
  const expired = { ...action, expiresAt: "2000-01-01T00:00:00.000Z" };
  get.mockResolvedValue(expired); render(<Card action={expired} />);
  fireEvent.click(screen.getByRole("button", { name: "Review current action" }));
  await screen.findByText(/This proposal expired/);
  expect(screen.queryByRole("button", { name: "Confirm and execute" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull(); expect(execute).not.toHaveBeenCalled();
});

test("a proposal expiring while open removes confirmation without a page reload", async () => {
  jest.useFakeTimers();
  try {
    const pending = { ...action, expiresAt: new Date(Date.now() + 2000).toISOString() };
    get.mockResolvedValue(pending); render(<Card action={pending} />);
    fireEvent.click(screen.getByRole("button", { name: "Review current action" }));
    await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { jest.advanceTimersByTime(2001); });
    expect(screen.queryByRole("button", { name: "Confirm and execute" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
