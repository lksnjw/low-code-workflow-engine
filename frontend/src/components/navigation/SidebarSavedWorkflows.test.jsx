/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom/jest-globals";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { authorityScope, transitionAuthority } from "../../utils/authAuthority";
import { workflowService } from "../../services/workflow.service";
let user = { id: "owner", role: "Builder", permissions: ["workflow:read_own", "chat:use"] };
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => { transitionAuthority(user); return { user }; } }));
const { default: SidebarSavedWorkflows, savedWorkflowLocation } = await import("./SidebarSavedWorkflows");
afterEach(() => { cleanup(); jest.restoreAllMocks(); user = { id: "owner", role: "Builder", permissions: ["workflow:read_own", "chat:use"] }; });
const item = { id: "saved", name: "Customer onboarding", owner: { id: "owner" }, chatSessionId: "original-chat", steps: 0, publishedVersion: 0 };
function Location() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}</output>; }
function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><SidebarSavedWorkflows /><Location /></MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}
test("saved zero-step drafts remain visible and open the owner's chat canvas, not the detail page", async () => {
  const list = jest.spyOn(workflowService, "listPage").mockResolvedValue({ items: [item], meta: { page: 1, totalPages: 1 } });
  const view = open(); fireEvent.click(await screen.findByRole("link", { name: /Customer onboarding/ }));
  expect(screen.getByLabelText("Current route")).toHaveTextContent("/chat/original-chat?workflow=saved");
  expect(screen.getByText("Saved draft · 0 steps")).toBeVisible();
  expect(list).toHaveBeenCalledWith({ relevance: "relevant", page: 1, limit: 20 }, expect.any(AbortSignal)); view.client.clear();
});
test("older workflows are fetched only after an explicit page action", async () => {
  const list = jest.spyOn(workflowService, "listPage").mockImplementation(async params => ({ items: [{ ...item, name: params.page === 1 ? "Newest draft" : "Older draft" }], meta: { page: params.page, totalPages: 2 } }));
  const view = open(); await screen.findByText("Newest draft"); expect(list).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Older workflows" })); await screen.findByText("Older draft");
  expect(screen.queryByText("Newest draft")).toBeNull(); expect(list).toHaveBeenLastCalledWith({ relevance: "relevant", page: 2, limit: 20 }, expect.any(AbortSignal)); view.client.clear();
});
test("query invalidation after a save updates metadata without another full source download", async () => {
  const list = jest.spyOn(workflowService, "listPage").mockResolvedValueOnce({ items: [], meta: { totalPages: 0 } }).mockResolvedValue({ items: [item], meta: { totalPages: 1 } });
  const view = open(); await screen.findByText("No saved workflows on this page.");
  await view.client.invalidateQueries({ queryKey: ["workflows", authorityScope(user)] });
  await screen.findByText("Customer onboarding"); expect(list).toHaveBeenCalledTimes(2); view.client.clear();
});
test("a workflow reader never gets routed into another user's private chat", () => {
  expect(savedWorkflowLocation({ ...item, owner: "Owner", ownerRecord: { id: "owner", name: "Owner" } }, user)).toBe("/chat/original-chat?workflow=saved");
  expect(savedWorkflowLocation({ ...item, owner: { id: "someone-else" } }, user)).toBe("/chat?workflow=saved");
  expect(savedWorkflowLocation(item, { ...user, permissions: ["workflow:read_own"] })).toBe("/workflows/saved");
});
test("errors are not shown as an empty success list and can be retried", async () => {
  jest.spyOn(workflowService, "listPage").mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ items: [item], meta: {} });
  const view = open(); fireEvent.click(await screen.findByRole("button", { name: "Retry workflow list" })); await screen.findByText("Customer onboarding");
  expect(screen.queryByText("No saved workflows on this page.")).toBeNull(); view.client.clear();
});
test("a role without workflow read permission does not load metadata", async () => {
  user = { ...user, permissions: ["chat:use"] }; const list = jest.spyOn(workflowService, "listPage"); const view = open();
  await waitFor(() => expect(list).not.toHaveBeenCalled()); view.client.clear();
});
