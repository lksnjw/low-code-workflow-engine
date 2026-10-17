/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { apiClient } from "../../config/axios";
const auth = { user: { id: "me", timezone: "UTC", permissions: ["workflow:read_own", "execution:read_own", "chat:use"] } };
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => auth }));
const { default: DashboardPage } = await import("./DashboardPage");
const clients = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); jest.restoreAllMocks(); });
const task = (id, overrides = {}) => ({ id, kind: "run", name: id, status: "RUNNING", at: "2026-10-08T10:00:00Z", date: "2026-10-08", workflowId: "flow", executionId: id, important: false, ...overrides });
const response = (month = "2026-10") => ({ profile: "personal-task-dashboard/v1", scope: "personal", generatedAt: "2026-10-08T20:00:00Z", month, timezone: "UTC", today: "2026-10-08",
  counts: { today: 1, ongoing: 1, attention: 1, completedToday: 0 }, dayCounts: month === "2026-10" ? { "2026-10-08": { total: 1, important: 0 }, "2026-10-09": { total: 1, important: 1 } } : {},
  events: month === "2026-10" ? [task("Today report"), task("Next report", { kind: "schedule", at: "2026-10-09T10:00:00Z", date: "2026-10-09", executionId: null, status: "ACTIVE", important: true, cadence: "daily", scheduleTimezone: "UTC" })] : [],
  ongoing: [task("Older ongoing report", { date: "2026-09-30", at: "2026-09-30T10:00:00Z" })], attention: [task("Approval required", { status: "AWAITING_APPROVAL", important: true })], truncated: false });
function setup(value) {
  const get = jest.spyOn(apiClient, "get").mockImplementation(async (_url, options) => ({ data: { success: true, data: value ?? response(options.params.month) } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  render(<MemoryRouter><QueryClientProvider client={client}><DashboardPage /></QueryClientProvider></MemoryRouter>);
  return get;
}
test("day agenda and right calendar display readable saved tasks and accessible counts", async () => {
  setup(); await screen.findByRole("region", { name: "Task calendar" });
  // The real initial month comes from the clock; choose the server-confirmed today.
  fireEvent.click(screen.getByRole("button", { name: "Back to today" }));
  expect((await screen.findByRole("link", { name: "Today report" })).getAttribute("href")).toBe("/executions/Today%20report");
  expect(screen.getByRole("button", { name: /October 9, 2026, 1 tasks, 1 important/ })).toBeTruthy();
  expect(screen.getByText("Calendar timezone: UTC")).toBeTruthy(); expect(screen.queryByText(/structuredContent|runtimeApprovalSecret/)).toBeNull();
});
test("selecting a calendar number changes the agenda without starting a scheduled action", async () => {
  const get = setup(); await screen.findByRole("region", { name: "Task calendar" }); fireEvent.click(screen.getByRole("button", { name: "Back to today" }));
  const date = await screen.findByRole("button", { name: /October 9, 2026, 1 tasks, 1 important/ }); fireEvent.click(date);
  expect(screen.getByRole("link", { name: "Next report" }).getAttribute("href")).toBe("/workflows/flow");
  expect(screen.getByText("Scheduled · not started")).toBeTruthy(); expect(screen.queryByRole("link", { name: "Today report" })).toBeNull();
  expect(get.mock.calls.every(([url]) => url === "/dashboard/tasks")).toBe(true);
});
test("ongoing and attention tabs retain earlier tasks and never imply approval or completion", async () => {
  setup(); await screen.findByRole("tab", { name: "Ongoing" }); fireEvent.click(screen.getByRole("tab", { name: "Ongoing" }));
  expect(screen.getByRole("link", { name: "Older ongoing report" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Needs attention" })); expect(screen.getByRole("link", { name: "Approval required" })).toBeTruthy();
  expect(screen.getByText("Awaiting approval")).toBeTruthy(); expect(screen.queryByRole("button", { name: /^Approve$|^Run$|^Retry$/ })).toBeNull();
});
test("month navigation changes the server query and can return to today", async () => {
  const get = setup(); await screen.findByRole("region", { name: "Task calendar" }); fireEvent.click(screen.getByRole("button", { name: "Back to today" }));
  await screen.findByRole("button", { name: /October 9, 2026/ }); fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  await waitFor(() => expect(get.mock.calls.some(([, options]) => options.params.month === "2026-11")).toBe(true));
  expect(await screen.findByText("November 2026")).toBeTruthy(); expect(screen.getByText("No recorded tasks for this date.")).toBeTruthy();
});
test("storage/API failure does not fabricate zero tasks or retain current-looking counts", async () => {
  setup(); await screen.findByRole("region", { name: "Task calendar" }); jest.spyOn(apiClient, "get").mockRejectedValue(new Error("storage unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh tasks" })); await screen.findByText(/current tasks could not be confirmed/);
  expect(screen.queryByRole("region", { name: "Task calendar" })).toBeNull(); expect(screen.queryByText("Completed today")).toBeNull();
});
test("a clipped view warns instead of suggesting a complete empty agenda", async () => {
  setup({ ...response(new Date().toISOString().slice(0, 7)), events: [], dayCounts: {}, truncated: true });
  expect(await screen.findByText(/limited task list/)).toBeTruthy();
});
test("clipped date records are not mislabeled as an empty saved date", async () => {
  const month = new Date().toISOString().slice(0, 7), date = `${month}-01`;
  setup({ ...response(month), today: date, events: [], dayCounts: { [date]: { total: 20, important: 0 } }, truncated: true });
  expect(await screen.findByText(/Additional tasks for this date/)).toBeTruthy(); expect(screen.queryByText("No recorded tasks for this date.")).toBeNull();
});
test("task tabs support arrow, Home and End keys with visible focus", async () => {
  setup(); const day = await screen.findByRole("tab", { name: "Daily tasks" }); day.focus(); fireEvent.keyDown(day, { key: "ArrowRight" });
  expect(document.activeElement.textContent).toBe("Ongoing"); expect(screen.getByRole("link", { name: "Older ongoing report" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement, { key: "End" }); expect(document.activeElement.textContent).toBe("Needs attention");
  fireEvent.keyDown(document.activeElement, { key: "Home" }); expect(document.activeElement.textContent).toBe("Daily tasks");
});
