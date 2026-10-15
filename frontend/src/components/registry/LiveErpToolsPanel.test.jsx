/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const liveTools = jest.fn();
jest.unstable_mockModule("../../services/registry.service", () => ({ registryService: { liveTools } }));
const { default: Panel } = await import("./LiveErpToolsPanel.jsx");
const clients = [];
const tool = name => ({ name, description: `Current ${name}`, effect: "READ" });
const page = (overrides = {}) => ({ source: "erpbridge", connectionId: "erpbridge-default", total: 43, matchedCount: 43, offset: 0, limit: 20,
  nextOffset: null, discoveredAt: "2026-10-19T08:00:00.000Z", tools: Array.from({ length: 43 }, (_, index) => tool(index === 0 ? "live_first" : index === 20 ? "live_second" : index === 42 ? "create_customer" : `tool_${index}`)), connections: [{ id: "erpbridge-default" }], ...overrides });
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client); return render(<QueryClientProvider client={client}><Panel /></QueryClientProvider>); }
beforeEach(() => { liveTools.mockReset(); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

test("only current bridge entries render; details are fetched only when View is clicked", async () => {
  liveTools.mockImplementation(async args => args.toolName ? { source: "erpbridge", tool: { name: args.toolName, inputSchema: { required: ["customer_name"] } } } : page());
  mount(); await screen.findByText("live_first");
  expect(liveTools).toHaveBeenCalledTimes(1); expect(screen.queryByText("customer_name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View live_first" }));
  expect(await screen.findByText(/"customer_name"/)).toBeTruthy();
  expect(liveTools).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: "live_first" }));
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  expect(screen.queryByRole("region", { name: "ERPBridge tool definition" })).toBeNull();
});
test("fetches all summaries once, pages locally, and refresh fetches a new first page", async () => {
  let refreshed = false;
  liveTools.mockImplementation(async () => page(refreshed ? { total: 1, tools: [tool("new_remote_tool")] } : {}));
  mount(); await screen.findByText("live_first");
  expect(screen.getByRole("button", { name: "Previous tools" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next tools" })); await screen.findByText("live_second");
  expect(screen.queryByText("live_first")).toBeNull();
  expect(liveTools).toHaveBeenCalledTimes(1);
  expect(liveTools).toHaveBeenLastCalledWith({ limit: "all", connectionId: "" });
  fireEvent.click(screen.getByRole("button", { name: "Previous tools" })); await screen.findByText("live_first");
  expect(liveTools).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Next tools" })); await screen.findByText("live_second");
  refreshed = true; fireEvent.click(screen.getByRole("button", { name: "Refresh tools" })); await screen.findByText("new_remote_tool");
  expect(screen.queryByText("live_second")).toBeNull();
  expect(liveTools).toHaveBeenLastCalledWith({ limit: "all", connectionId: "" });
  const calls = liveTools.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh tools" }));
  await waitFor(() => expect(liveTools).toHaveBeenCalledTimes(calls + 1));
});
test("search is submitted explicitly and distinguishes matching count from full inventory", async () => {
  liveTools.mockResolvedValue(page());
  mount(); await screen.findByText("live_first");
  fireEvent.change(screen.getByRole("textbox", { name: "Search ERPBridge tools" }), { target: { value: "customer" } });
  expect(liveTools).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Search", exact: true })); await screen.findByText("create_customer");
  expect(screen.getByRole("status").textContent).toContain("43 tools exposed · 1 matching");
  expect(screen.getByRole("button", { name: "Next tools" }).disabled).toBe(true);
  expect(liveTools).toHaveBeenCalledTimes(1);
});
test("a refresh failure removes old entries and never shows a built-in fallback", async () => {
  liveTools.mockResolvedValueOnce(page()); mount(); await screen.findByText("live_first");
  liveTools.mockRejectedValue(new Error("Bridge unavailable")); fireEvent.click(screen.getByRole("button", { name: "Refresh tools" }));
  await screen.findByRole("alert"); expect(screen.queryByText("live_first")).toBeNull(); expect(screen.queryByText("demo.echo")).toBeNull();
});
