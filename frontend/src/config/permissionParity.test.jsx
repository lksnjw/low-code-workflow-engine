/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { apiClient } from "../config/axios.js";

let permissions = new Set();
const rebuild = jest.fn();
const notify = jest.fn();
const registryLoad = jest.fn();
const registryCreate = jest.fn();
const registryUpdate = jest.fn();

jest.unstable_mockModule("../hooks/usePermissions", () => ({
  default: () => ({ has: (permission) => permissions.has(permission), hasAny: (required) => required.some((permission) => permissions.has(permission)) }),
  usePermissions: () => ({ has: (permission) => permissions.has(permission), hasAny: (required) => required.some((permission) => permissions.has(permission)) }),
}));

jest.unstable_mockModule("../hooks/useSemanticStatus", () => ({
  default: () => ({
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    data: { health: { documents: 3, method: "lexical" }, metadata: { ready: true, document_count: 3 } },
  }),
}));

jest.unstable_mockModule("../services/semantic.service", () => ({
  semanticService: { rebuild },
}));

jest.unstable_mockModule("../services/registry.service", () => ({
  registryService: { load: registryLoad, create: registryCreate, update: registryUpdate },
}));

jest.unstable_mockModule("../context/NotificationContext", () => ({
  useNotifications: () => ({ notify }),
}));

jest.unstable_mockModule("../components/registry/RegistryBulkImportPanel", () => ({ default: () => null }));
jest.unstable_mockModule("../components/registry/RegistryGenerationContextViewer", () => ({ default: () => null }));
jest.unstable_mockModule("../components/registry/RegistryStatusBanner", () => ({ default: () => null }));

const { protectedRouteDefinitions } = await import("./router.jsx");
const { default: AuditPage } = await import("../pages/users/AuditPage.jsx");
const { default: DatafeedPage } = await import("../pages/datafeed/DatafeedPage.jsx");
const { default: RegistryPage } = await import("../pages/registry/RegistryPage.jsx");

afterEach(() => {
  cleanup();
  permissions = new Set();
  rebuild.mockReset();
  notify.mockReset();
  registryLoad.mockReset();
  registryCreate.mockReset();
  registryUpdate.mockReset();
  jest.restoreAllMocks();
});

test("audit-only user loads audit data without administration endpoints", async () => {
  permissions = new Set(["audit:read"]);
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: [] } });
  const route = protectedRouteDefinitions.find((definition) => definition.id === "users.audit");
  expect(route.requiredAny).toEqual(["audit:read"]);

  const queryClient = renderWithQuery(<AuditPage />);
  expect(await screen.findByText("No audit events recorded.")).not.toBeNull();
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith("/audit", { params: { limit: 20 } });
  expect(get.mock.calls.some(([path]) => ["/users", "/roles", "/permissions", "/permissions/matrix"].includes(path))).toBe(false);
  queryClient.clear();
});

test("workflow-read-only user sees datafeed status without rebuild action", async () => {
  permissions = new Set(["workflow:read"]);
  const queryClient = renderWithQuery(<DatafeedPage />);

  expect(screen.getByText("Index Status")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Rebuild Index" })).toBeNull();
  expect(screen.getByText(/Read only.*settings permission required to rebuild/i)).not.toBeNull();
  expect(rebuild).not.toHaveBeenCalled();
  queryClient.clear();
});

test("registry writer without settings permission cannot trigger semantic rebuild", async () => {
  permissions = new Set(["registry:read", "registry:write"]);
  registryLoad.mockResolvedValue({ tools: [], rules: [] });
  registryCreate.mockResolvedValue({});
  const queryClient = renderWithQuery(<RegistryPage />, true);

  fireEvent.click(await screen.findByRole("button", { name: "Add tool" }));
  fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
  await waitFor(() => expect(registryCreate).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(
    "Registry saved. A settings manager can rebuild semantic search if needed.",
    "success",
  ));
  expect(rebuild).not.toHaveBeenCalled();
  expect(notify.mock.calls.some((call) => call[2]?.label === "Rebuild index")).toBe(false);
  queryClient.clear();
});

function renderWithQuery(component, withRouter = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const content = withRouter ? <MemoryRouter>{component}</MemoryRouter> : component;
  render(<QueryClientProvider client={queryClient}>{content}</QueryClientProvider>);
  return queryClient;
}
