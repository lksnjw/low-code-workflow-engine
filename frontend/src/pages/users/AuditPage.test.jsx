/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { apiClient } from "../../config/axios.js";
import AuditPage from "./AuditPage.jsx";

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test("AuditPage renders the returned audit total", async () => {
  jest.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      success: true,
      data: [
        { id: "audit_1", action: "workflow.published", createdAt: "2026-08-20T00:00:00Z" },
        { id: "audit_2", action: "workflow.executed", createdAt: "2026-08-20T00:01:00Z" },
      ],
      meta: { total: 1204, limit: 20, offset: 0 },
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AuditPage />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Showing 2 of 1,204 audit events.")).not.toBeNull();
  queryClient.clear();
});
