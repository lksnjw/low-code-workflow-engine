/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const get = jest.fn(), patch = jest.fn();
let role = "Platform Admin", hasSettings = true;
jest.unstable_mockModule("../../config/axios", () => ({ apiClient: { get, patch } }));
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ usePermissions: () => ({ actorId: "admin", roleId: "admin-role", role, has: () => hasSettings }) }));
const { default: Panel } = await import("./RuntimeApprovalPolicyPanel.jsx");
const policy = { profile: "runtime-approval-policy/v1", enabled: true, approverRoleIds: ["reviewer"], ttlSeconds: 300, separationOfDuties: true, revision: 1 };
const view = (extra = {}) => ({ profile: "runtime-approval-administration/v1", policy, revision: 1, roles: [{ id: "reviewer", name: "Independent reviewer", eligible: true }], canManage: true, memoryOnly: true, asOf: "2026-10-06T12:00:00.000Z", canExecute: false, ...extra });
const envelope = data => ({ data: { success: true, data } });
const clients = [];
function show(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  clients.push(client); return render(<QueryClientProvider client={client}><Panel /></QueryClientProvider>);
}
async function reviewChange(ttl = "600") {
  fireEvent.change(await screen.findByRole("spinbutton", { name: /Approval validity in seconds/ }), { target: { value: ttl } });
  fireEvent.click(screen.getByRole("button", { name: "Review policy change" }));
}
beforeEach(() => { sessionStorage.clear(); role = "Platform Admin"; hasSettings = true; get.mockResolvedValue(envelope(view())); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); get.mockReset(); patch.mockReset(); jest.restoreAllMocks(); });
test("readable policy changes require review then explicit confirmation, not a toggle dispatch", async () => {
  patch.mockImplementation(async (_url, body) => { const saved = { ...policy, ttlSeconds: body.runtimeApprovalPolicy.ttlSeconds, revision: 2 }; get.mockResolvedValue(envelope(view({ policy: saved, revision: 2 }))); return envelope({ runtimeApprovalPolicy: saved }); });
  const rendered = show(); await reviewChange(); expect(patch).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "Review approval policy change" })).toBeTruthy(); expect(rendered.container.querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm policy change" }));
  await screen.findByText(/revision 2 saved and freshly confirmed/); expect(patch).toHaveBeenCalledTimes(1);
  expect(patch.mock.calls[0][1]).toEqual({ runtimeApprovalPolicy: { profile: policy.profile, baseRevision: 1, enabled: true, ttlSeconds: 600, approverRoleIds: ["reviewer"], separationOfDuties: true } });
  expect(sessionStorage.getItem("workflow.approval-policy.admin")).toBeNull(); expect(screen.getByText(/Memory-only settings/)).toBeTruthy();
});
test("disabled policies block effects and cancellation/edited previews never dispatch", async () => {
  show(); await reviewChange(); fireEvent.click(screen.getByRole("button", { name: "Cancel policy review" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable independent runtime approvals" })); fireEvent.click(screen.getByRole("button", { name: "Review policy change" }));
  expect(screen.getByText(/Governed effects blocked · 600 seconds/)).toBeTruthy();
  fireEvent.change(screen.getByRole("spinbutton", { name: /Approval validity in seconds/ }), { target: { value: "120" } });
  expect(screen.queryByRole("button", { name: "Confirm policy change" })).toBeNull(); expect(patch).not.toHaveBeenCalled();
});
test("lost ACK locks another change across remount; explicit authoritative reload ends local uncertainty, never retries", async () => {
  patch.mockRejectedValue(new Error("Synthetic ACK lost")); const first = show(); await reviewChange(); fireEvent.click(screen.getByRole("button", { name: "Confirm policy change" }));
  await screen.findByRole("alert"); expect(sessionStorage.getItem("workflow.approval-policy.admin")).not.toBeNull();
  first.unmount(); const saved = { ...policy, ttlSeconds: 600, revision: 2 }; get.mockResolvedValue(envelope(view({ policy: saved, revision: 2 }))); show();
  await screen.findByText(/Unconfirmed policy change/); await screen.findByText(/Saved revision 2/); expect(screen.getByRole("button", { name: "Review policy change" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved policy" })); await screen.findByText(/does not prove an earlier request/);
  expect(patch).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem("workflow.approval-policy.admin")).toBeNull();
});
test("no settings grant, a non-admin role or a failed current read cannot configure approval authority", async () => {
  hasSettings = false; show(); expect(screen.queryByText("Runtime approvals")).toBeNull(); expect(get).not.toHaveBeenCalled(); cleanup();
  hasSettings = true; role = "Settings reader"; get.mockResolvedValue(envelope(view({ canManage: false }))); show();
  await screen.findByText(/Read only/); expect(screen.getByRole("button", { name: "Review policy change" })).toBeDisabled(); cleanup();
  role = "Platform Admin"; get.mockRejectedValue(new Error("Storage denied")); show(); await screen.findByText("Storage denied");
  expect(screen.queryByRole("spinbutton")).toBeNull(); expect(patch).not.toHaveBeenCalled();
});
test("ineligible selected roles must be removed explicitly and missing eligible roles never auto-grant permission", async () => {
  get.mockResolvedValue(envelope(view({ roles: [{ id: "reviewer", name: "Revoked reviewer", eligible: false }, { id: "other", name: "Another eligible reviewer", eligible: true }] }))); show();
  await screen.findByText(/No longer eligible/); expect(screen.getByRole("button", { name: "Review policy change" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Revoked reviewer/ })); fireEvent.click(screen.getByRole("checkbox", { name: "Another eligible reviewer" }));
  expect(screen.getByRole("button", { name: "Review policy change" })).not.toBeDisabled(); expect(patch).not.toHaveBeenCalled(); cleanup();
  get.mockResolvedValue(envelope(view({ policy: null, revision: 0, roles: [] }))); show(); await screen.findByText(/No eligible roles/);
  expect(screen.getByText(/Independent reviewer policy not configured/)).toBeTruthy(); expect(screen.getByText(/server checks any Super Admin exception/)).toBeTruthy(); expect(screen.getByRole("button", { name: "Review policy change" })).toBeDisabled();
});
test("local tracking failure prevents dispatch and corrupt pending state requires an explicit fresh reload", async () => {
  show(); await reviewChange(); jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("No local tracking"); });
  fireEvent.click(screen.getByRole("button", { name: "Confirm policy change" })); await screen.findByText("No local tracking"); expect(patch).not.toHaveBeenCalled(); cleanup(); jest.restoreAllMocks();
  sessionStorage.setItem("workflow.approval-policy.admin", "false"); show(); await screen.findByText(/Unconfirmed policy change/);
  await screen.findByText(/Saved revision 1/); fireEvent.click(screen.getByRole("button", { name: "Reload saved policy" })); await screen.findByText(/Current saved policy reloaded/); expect(sessionStorage.length).toBe(0);
});
test("a stale cache is not editable before fresh mount confirmation", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); client.setQueryData(["approval-policy", "admin"], view());
  let finish; get.mockImplementation(() => new Promise(resolve => { finish = () => resolve(envelope(view({ policy: null, revision: 0, roles: [] }))); })); show(client);
  expect(screen.queryByRole("spinbutton")).toBeNull(); await waitFor(() => expect(finish).toEqual(expect.any(Function))); finish(); await screen.findByText(/Independent reviewer policy not configured/); expect(patch).not.toHaveBeenCalled();
});
test("a different fresh policy after valid ACK remains unconfirmed and cannot be silently resubmitted", async () => {
  patch.mockImplementation(async () => { get.mockResolvedValue(envelope(view({ policy: { ...policy, revision: 3 }, revision: 3 }))); return envelope({ runtimeApprovalPolicy: { ...policy, ttlSeconds: 600, revision: 2 } }); });
  show(); await reviewChange(); fireEvent.click(screen.getByRole("button", { name: "Confirm policy change" })); await screen.findByText(/differs from the acknowledgement/);
  expect(screen.getByRole("button", { name: "Review policy change" })).toBeDisabled(); expect(sessionStorage.getItem("workflow.approval-policy.admin")).not.toBeNull(); expect(patch).toHaveBeenCalledTimes(1);
});

test("explicit saved-policy reload replaces an unsaved editor and review without dispatch", async () => {
  show(); await reviewChange("600");
  expect(screen.getByRole("group", { name: "Review approval policy change" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved policy" }));
  await screen.findByText(/Current saved policy reloaded/);
  expect(screen.getByRole("spinbutton", { name: /Approval validity in seconds/ })).toHaveValue(300);
  expect(screen.queryByRole("group", { name: "Review approval policy change" })).toBeNull();
  expect(screen.getByRole("button", { name: "Review policy change" })).toBeDisabled();
  expect(patch).not.toHaveBeenCalled();
});
