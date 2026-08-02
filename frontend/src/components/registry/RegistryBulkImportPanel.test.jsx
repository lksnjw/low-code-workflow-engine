/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const bulkImport = jest.fn();
const context = jest.fn();

jest.unstable_mockModule("../../hooks/usePermissions", () => ({
  default: () => ({ has: (permission) => permission === "settings:manage" }),
}));

jest.unstable_mockModule("../../services/registry.service", () => ({
  registryService: {
    bulkImport,
    context,
  },
}));

const { default: RegistryBulkImportPanel } = await import("./RegistryBulkImportPanel.jsx");
const { default: RegistryGenerationContextViewer } = await import("./RegistryGenerationContextViewer.jsx");

afterEach(() => {
  cleanup();
  bulkImport.mockReset();
  context.mockReset();
});

test("registry import control reports every failure from a mixed-validity batch", async () => {
  bulkImport.mockRejectedValue({
    response: {
      data: {
        data: {
          applied: false,
          count: 0,
          errors: [
            { index: 1, id: "BAD-TOOL", reason: "required fields missing: name" },
            { index: 2, id: "DUPLICATE-TOOL", reason: "tool id is duplicated in the batch" },
          ],
        },
      },
    },
  });
  const queryClient = testQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RegistryBulkImportPanel kind="tools" />
    </QueryClientProvider>,
  );

  fireEvent.change(screen.getByLabelText("tools import JSON"), {
    target: { value: '[{"tool_id":"GOOD-TOOL"},{"tool_id":"BAD-TOOL"},{"tool_id":"DUPLICATE-TOOL"}]' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Validate & import" }));

  await waitFor(() => expect(bulkImport).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("0 imported")).not.toBeNull();
  expect(screen.getByText("Nothing was applied.")).not.toBeNull();
  expect(screen.getByText("Index 1 · BAD-TOOL")).not.toBeNull();
  expect(screen.getByText("required fields missing: name")).not.toBeNull();
  expect(screen.getByText("Index 2 · DUPLICATE-TOOL")).not.toBeNull();
  expect(screen.getByText("tool id is duplicated in the batch")).not.toBeNull();
  queryClient.clear();
});

test("registry generation-context viewer renders read-only Markdown", async () => {
  context.mockResolvedValue({
    frontMatter: { registryHash: "sha256:current" },
    markdown: "<!-- registry_sha256: sha256:current -->\n# Runtime Registry Generation Context",
  });
  const queryClient = testQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RegistryGenerationContextViewer />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Generation context (not used for validation)")).not.toBeNull();
  expect(await screen.findByText(/Runtime Registry Generation Context/)).not.toBeNull();
  expect(screen.getByText("sha256:current")).not.toBeNull();
  queryClient.clear();
});

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}
