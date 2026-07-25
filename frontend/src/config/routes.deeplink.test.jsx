/** @jest-environment jsdom */

import { expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const useExecution = jest.fn((executionId) => ({
  execution: {
    id: executionId,
    workflowName: "Deep-link workflow",
    status: "DONE",
    started: "2026-07-25 10:00",
    duration: "12ms",
    tokens: "0",
    cost: "$0.00",
  },
  logs: [],
  timeline: [],
  healingReport: null,
  loading: false,
  error: null,
  reload: jest.fn(),
}));

jest.unstable_mockModule("../hooks/useExecution", () => ({
  useExecution,
  default: useExecution,
}));

jest.unstable_mockModule("../hooks/usePermissions", () => ({
  default: () => ({ hasAny: () => true }),
}));

const { ProtectedScreen, protectedRouteDefinitions } = await import("./router.jsx");

test("routes.deeplink.test", async () => {
  const definition = protectedRouteDefinitions.find((route) => route.id === "executions.detail");

  render(
    <MemoryRouter initialEntries={["/executions/run-deep-link"]}>
      <Routes>
        <Route path={definition.path} element={<ProtectedScreen definition={definition} />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Deep-link workflow" })).not.toBeNull();
  await waitFor(() => expect(useExecution).toHaveBeenCalledWith("run-deep-link"));
  cleanup();
});
