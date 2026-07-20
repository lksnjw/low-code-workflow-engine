/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { apiClient } from "../../config/axios.js";

const notify = jest.fn();
jest.unstable_mockModule("../../context/NotificationContext", () => ({
  useNotifications: () => ({ notify }),
}));

jest.unstable_mockModule("../../hooks/usePermissions", () => ({
  default: () => ({
    has: () => false,
    hasAny: () => true,
  }),
}));

const { default: WorkflowActions } = await import("./WorkflowActions.jsx");

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  notify.mockClear();
});

test("validates runtime JSON and sends the parsed object to the execution endpoint", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({
    data: {
      success: true,
      data: {
        id: "exec_1",
        workflowName: "Client echo",
        status: "DONE",
        durationMs: 12,
      },
    },
  });
  const onChanged = jest.fn();

  render(<WorkflowActions workflow={{ id: "wf_1", name: "Client echo" }} onChanged={onChanged} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  const input = screen.getByLabelText("Runtime input (JSON)");
  expect(input.value).toBe("{}");

  fireEvent.change(input, { target: { value: "[]" } });
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Runtime input must be a JSON object.");
  expect(post).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: '{"message":"hello","amount":10}' } });
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));

  await waitFor(() => {
    expect(post).toHaveBeenCalledWith("/workflows/wf_1/run", {
      input: { message: "hello", amount: 10 },
    });
  });
  expect(notify).toHaveBeenCalledWith("Execution exec_1 finished with status DONE.", "success");
  expect(onChanged).toHaveBeenCalledTimes(1);
});
