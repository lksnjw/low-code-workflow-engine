/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { apiClient } from "../../config/axios";
let user = { id: "manager", roleId: "reviewer", role: "Manager", permissions: ["execution:approve"] };
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => ({ user }) }));
const { default: DashboardApprovalQueue } = await import("./DashboardApprovalQueue");
const { default: DashboardPage } = await import("../../pages/dashboard/DashboardPage");
const clients = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); jest.restoreAllMocks(); user = { id: "manager", roleId: "reviewer", role: "Manager", permissions: ["execution:approve"] }; });
const item = { kind: "approval", state: "open", executionId: "night-run", reviewId: "exact-review", reviewView: "approval", nodeId: "update_stock", workflowName: "Overnight inventory plan", toolName: "stock.update", requesterName: "Scheduler", requestedAt: "2026-10-16T21:00:00Z", scheduledFor: "2026-10-16T20:30:00Z", expiresAt: "2026-10-17T21:00:00Z", executionStatus: "AWAITING_APPROVAL", statusLabel: "Awaiting decision", detail: "Review exact changes", reviewAvailable: true, actionable: true, canResume: false, noReplay: true };
const page = (items = [item], overrides = {}) => ({ profile: "execution-review-inbox/v1", kind: "approval", state: "open", scopes: { approval: true, reconciliation: false }, items, hasMore: false, nextCursor: null, asOf: "2026-10-17T07:00:00Z", canResume: false, noReplay: true, ...overrides });
function mount(element = <DashboardApprovalQueue />, value = page()) {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: value } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  const view = render(<MemoryRouter><QueryClientProvider client={client}>{element}</QueryClientProvider></MemoryRouter>);
  return { ...view, get, client };
}

test("manager sees an earlier scheduled request with its exact waiting step and durable-review link", async () => {
  const { get } = mount();
  await screen.findByText("Overnight inventory plan");
  expect(screen.getByText("Step: update_stock · stock.update")).toBeTruthy(); expect(screen.getByText(/Scheduled run:/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open exact review for Overnight inventory plan" }).getAttribute("href")).toBe("/executions/night-run?view=approval&approvalId=exact-review");
  expect(screen.queryByRole("button", { name: /^Approve$|^Run$/ })).toBeNull();
  expect(get).toHaveBeenCalledWith("/execution-reviews", expect.objectContaining({ params: { kind: "approval", state: "open", limit: 25 } }));
});

test("approval-only managers use Dashboard without requesting private run data or workflow lists", async () => {
  const { get } = mount(<DashboardPage />);
  await screen.findByText("Overnight inventory plan");
  expect(get.mock.calls.every(([url]) => url === "/execution-reviews")).toBe(true);
  expect(screen.queryByRole("button", { name: "Refresh tasks" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Open workspace" })).toBeNull();
});

test("expired overnight requests stay visible as review issues, not as approvable work", async () => {
  mount(undefined, page([{ ...item, expiresAt: "2026-10-17T06:00:00Z", actionable: false }]));
  await screen.findByText("Review expired · cannot approve this request");
  expect(screen.getByRole("link", { name: "Inspect review issue for Overnight inventory plan" })).toBeTruthy();
});

test("a failed refresh hides earlier metadata and never shows an empty-queue success message", async () => {
  const { get } = mount(); await screen.findByText("Overnight inventory plan");
  get.mockRejectedValue(new Error("Storage offline")); fireEvent.click(screen.getByRole("button", { name: "Refresh approvals" }));
  await screen.findByRole("alert"); expect(screen.queryByText("Overnight inventory plan")).toBeNull();
  expect(screen.queryByText(/No pending approvals/)).toBeNull();
});

test("bounded queue uses the paginated inbox for older requests without pretending the first page is a total", async () => {
  mount(undefined, page(Array.from({ length: 7 }, (_, index) => ({ ...item, executionId: `run-${index}`, reviewId: `review-${index}` })), { hasMore: true, nextCursor: "cursor" }));
  await screen.findByText("Needs human approval · at least 7");
  expect(screen.getAllByRole("link", { name: "Open exact review for Overnight inventory plan" })).toHaveLength(5);
  expect(screen.getByRole("link", { name: "All review tasks →" }).getAttribute("href")).toBe("/executions/reviews?kind=approval");
});

test("non-reviewers cannot fetch review metadata and losing role authority removes the queue", async () => {
  const view = mount(); await screen.findByText("Overnight inventory plan");
  user = { ...user, permissions: [] }; view.rerender(<MemoryRouter><QueryClientProvider client={view.client}><DashboardApprovalQueue /></QueryClientProvider></MemoryRouter>);
  expect(screen.queryByRole("region", { name: "Human approvals waiting for you" })).toBeNull();
  await waitFor(() => expect(view.get).toHaveBeenCalledTimes(1));
});

test("a warm notification cache never delays dashboard approval checking until the next poll", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000, gcTime: Infinity } } }); clients.push(client);
  client.setQueryData(["execution-review-inbox", user.id, "reviewer:execution:approve", "approval", "open", null], page([]));
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: page() } });
  render(<MemoryRouter><QueryClientProvider client={client}><DashboardApprovalQueue /></QueryClientProvider></MemoryRouter>);
  await screen.findByText("Overnight inventory plan"); expect(get).toHaveBeenCalledTimes(1);
});
