/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, beforeEach, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
let review;
jest.unstable_mockModule("../../context/NotificationContext", () => ({ useNotifications: () => ({ activity: [] }) }));
jest.unstable_mockModule("@tanstack/react-query", () => ({ useQuery: options => options.queryKey[0] === "execution-review-inbox" ? review : { isFetchedAfterMount: true, data: [], refetch: jest.fn() } }));
const { default: NotificationsMenu } = await import("./NotificationsMenu");
const user = { id: "reviewer", roleId: "reviewer", permissions: ["execution:approve"] };
beforeEach(() => { review = { isFetchedAfterMount: true, isError: false, refetch: jest.fn(), data: { items: [{ workflowName: "Invoice review", executionId: "run", reviewId: "approval", reviewAvailable: true }] } }; });
afterEach(cleanup);
test("a current reviewer gets an actionable reminder without approving the action", () => {
  render(<MemoryRouter><NotificationsMenu user={user} /></MemoryRouter>);
  expect(screen.getByRole("status", { name: "Approval needs your attention" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Review request" }).getAttribute("href")).toBe("/executions/run?view=approval&approvalId=approval");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss approval reminder" }));
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  expect(screen.getByText("Invoice review")).toBeTruthy();
});
test.each(["denied", "unfetched", "wrong-role"])("%s approval data cannot create an attention popup", kind => {
  if (kind === "denied") review.isError = true;
  if (kind === "unfetched") review.isFetchedAfterMount = false;
  render(<MemoryRouter><NotificationsMenu user={kind === "wrong-role" ? { ...user, permissions: [] } : user} /></MemoryRouter>);
  expect(screen.queryByRole("status", { name: "Approval needs your attention" })).toBeNull();
});
