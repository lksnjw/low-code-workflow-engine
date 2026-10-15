/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const service = { list: jest.fn(), save: jest.fn(), test: jest.fn(), remove: jest.fn() };
jest.unstable_mockModule("../../services/user-erp.service", () => ({ userErpService: service }));
const { default: Panel } = await import("./UserErpConnections.jsx");
const data = (configured = false, revision = 0) => ({ connections: [{ id: "erpbridge-default", endpoint: "https://erp.example.test/mcp/", configured, revision, testedAt: null }] });
const clients = [];
function mount(actorId = "alice") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><Panel key={actorId} actorId={actorId} /></QueryClientProvider>);
}
beforeEach(() => { Object.values(service).forEach(fn => fn.mockReset()); service.list.mockResolvedValue(data()); });
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); });
test("missing token is explicit, password input is empty and endpoint cannot be edited", async () => {
  mount(); const input = await screen.findByLabelText("My ERPBridge token");
  expect(input).toHaveAttribute("type", "password"); expect(input).toHaveValue(""); expect(input).toHaveAttribute("autocomplete", "off");
  expect(screen.getByText("No personal token")).toBeTruthy(); expect(screen.getByRole("button", { name: "Test my connection" })).toBeDisabled();
  expect(screen.getByText(/administrator’s catalog token is not used/)).toBeTruthy();
  expect(screen.queryByLabelText(/endpoint/i)).toBeNull();
});
test("save uses current revision, clears token immediately and disables controls until acknowledgement", async () => {
  let finish; service.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount(); const input = await screen.findByLabelText("My ERPBridge token");
  fireEvent.change(input, { target: { value: "SYNTHETIC-TOKEN-ONLY" } }); fireEvent.click(screen.getByRole("button", { name: "Save my token" }));
  expect(input).toHaveValue(""); expect(input).toBeDisabled(); expect(service.save).toHaveBeenCalledWith("erpbridge-default", { baseRevision: 0, token: "SYNTHETIC-TOKEN-ONLY" });
  expect(service.test).not.toHaveBeenCalled(); finish(data(true, 1));
  await screen.findByText(/token was saved securely/); expect(screen.getByLabelText("Replace my ERPBridge token")).toHaveValue("");
  expect(document.body.textContent).not.toContain("SYNTHETIC-TOKEN-ONLY");
});
test("connection test does not submit token or call a business API", async () => {
  service.list.mockResolvedValue(data(true, 2)); service.test.mockResolvedValue(data(true, 2)); mount();
  fireEvent.click(await screen.findByRole("button", { name: "Test my connection" }));
  await screen.findByText(/Token connection and discovery passed/); expect(service.test).toHaveBeenCalledWith("erpbridge-default", { baseRevision: 2 });
  expect(service.save).not.toHaveBeenCalled();
});
test("removal requires explicit review then clears saved status", async () => {
  service.list.mockResolvedValue(data(true, 1)); service.remove.mockResolvedValue(data(false, 2)); mount();
  fireEvent.click(await screen.findByRole("button", { name: "Remove my token" })); expect(service.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep my token" })); expect(service.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove my token" })); fireEvent.click(screen.getByRole("button", { name: "Confirm token removal" }));
  await screen.findByText(/token was removed/); expect(service.remove).toHaveBeenCalledWith("erpbridge-default", { baseRevision: 1 });
  expect(screen.getByText("No personal token")).toBeTruthy();
});
test("conflict and uncertain errors are sanitized, do not echo token or automatically retry", async () => {
  service.save.mockRejectedValue({ response: { status: 409, data: { message: "SYNTHETIC-PRIVATE-TOKEN" } } }); mount();
  fireEvent.change(await screen.findByLabelText("My ERPBridge token"), { target: { value: "SYNTHETIC-PRIVATE-TOKEN" } }); fireEvent.click(screen.getByRole("button", { name: "Save my token" }));
  await screen.findByRole("alert"); expect(document.body.textContent).not.toContain("SYNTHETIC-PRIVATE-TOKEN"); expect(service.save).toHaveBeenCalledTimes(1);
});
test("fresh account panel has no old input or cached connection status", async () => {
  const first = mount(); fireEvent.change(await screen.findByLabelText("My ERPBridge token"), { target: { value: "ALICE-UNSAVED-TOKEN" } });
  first.unmount(); mount("bob"); expect(await screen.findByLabelText("My ERPBridge token")).toHaveValue("");
  expect(service.save).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("ALICE-UNSAVED-TOKEN");
});
test("empty catalog and loading state do not suggest configured ERP access", async () => {
  let finish; service.list.mockImplementation(() => new Promise(resolve => { finish = resolve; })); mount();
  expect(screen.getByText("Loading your ERP connections…")).toBeTruthy(); finish({ connections: [] });
  await waitFor(() => expect(screen.getByText(/administrator must configure/)).toBeTruthy());
});

test("server-managed admin credential is explicit and cannot be displayed, replaced or removed", async () => {
  const managed = { credentialMode: "administrator-environment", connections: [{ ...data(true).connections[0], source: "administrator-environment" }] };
  service.list.mockResolvedValue(managed); service.test.mockResolvedValue(managed); mount("admin");
  expect(await screen.findByText("Administrator environment credential · value hidden")).toBeTruthy();
  expect(screen.getByText(/Other roles must add their own tokens/)).toBeTruthy();
  expect(screen.queryByLabelText(/My ERPBridge token|Replace my ERPBridge token/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Save my token|Replace my token|Remove my token/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Test administrator connection" }));
  await screen.findByText(/Token connection and discovery passed/);
  expect(service.test).toHaveBeenCalledWith("erpbridge-default", { baseRevision: 0 });
  expect(service.save).not.toHaveBeenCalled(); expect(service.remove).not.toHaveBeenCalled();
});
