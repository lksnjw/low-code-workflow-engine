/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const catalog = jest.fn(), inventory = jest.fn();
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => ({ user: { id: "owner", role: "Platform Admin", permissions: ["pipeline:upload"] } }) }));
jest.unstable_mockModule("../../services/document-workspace.service", () => ({ documentWorkspaceService: { catalog, inventory } }));
const { default: Page } = await import("./VectorMetricsPage");
let client;
beforeEach(() => { catalog.mockReset(); inventory.mockReset(); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  catalog.mockResolvedValue({ collections: [], counts_complete: true, as_of: "2026-10-15T16:00:00Z" }); inventory.mockResolvedValue({ searchable_documents: 4, pending_review: 1, index_failed: 0, vector_index_configured: true }); });
afterEach(() => { cleanup(); client.clear(); });
const show = () => render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
test("metrics uses current pipeline collections, not the disconnected semantic/FAISS API", async () => {
  show(); expect(await screen.findByRole("heading", { name: "Document collection inventory" })).toBeTruthy();
  expect(screen.getByText("Permitted searchable documents").nextSibling).toHaveTextContent("4");
  expect(screen.getByRole("region", { name: "Schema collection destinations" })).toBeTruthy();
  expect(screen.queryByText("FAISS entries")).toBeNull();
});
test("refresh reloads authoritative summaries", async () => {
  show(); await screen.findByRole("heading", { name: "Document collection inventory" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh collections" })); await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
});
test("pipeline failure is visible and retry can recover", async () => {
  catalog.mockRejectedValueOnce(new Error("Pipeline unavailable")); show(); expect(await screen.findByRole("alert")).toHaveTextContent("Pipeline unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(await screen.findByRole("heading", { name: "Document collection inventory" })).toBeTruthy();
});
