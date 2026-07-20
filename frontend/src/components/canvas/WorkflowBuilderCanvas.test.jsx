/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { apiClient } from "../../config/axios.js";

jest.unstable_mockModule("@xyflow/react", () => {
  const Container = ({ children }) => React.createElement("div", null, children);
  return {
    addEdge: (connection, edges) => [...edges, connection],
    applyEdgeChanges: (_changes, edges) => edges,
    applyNodeChanges: (_changes, nodes) => nodes,
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: "arrow-closed" },
    MiniMap: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlow: Container,
    ReactFlowProvider: Container,
    useReactFlow: () => ({
      fitView: jest.fn(),
      screenToFlowPosition: (position) => position,
    }),
  };
});

const notify = jest.fn();
jest.unstable_mockModule("../../context/NotificationContext", () => ({
  useNotifications: () => ({ notify }),
}));

const { default: WorkflowBuilderCanvas } = await import("./WorkflowBuilderCanvas.jsx");

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  notify.mockClear();
});

test("writable builder loads and renders the registered tool catalog", async () => {
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      success: true,
      data: [
        {
          name: "demo.echo",
          display_name: "Demo Echo",
          description: "Deterministic catalog tool",
          module: "General",
          allowed_roles: ["Platform Admin"],
          required_parameters: ["message"],
        },
      ],
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <WorkflowBuilderCanvas readOnly={false} />
    </QueryClientProvider>,
  );

  expect(await screen.findByRole("button", { name: /Demo Echo/i })).not.toBeNull();
  await waitFor(() => {
    expect(get).toHaveBeenCalledWith("/tools/catalog", { params: { status: "available" } });
  });
  expect(screen.queryByText(/Cannot read properties of undefined/i)).toBeNull();
  expect(screen.queryByText(/Tool catalog unavailable/i)).toBeNull();

  queryClient.clear();
});
