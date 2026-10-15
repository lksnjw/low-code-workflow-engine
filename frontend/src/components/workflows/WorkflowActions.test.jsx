/** @jest-environment jsdom */

import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { apiClient } from "../../config/axios.js";

const notify = jest.fn();
jest.unstable_mockModule("../../context/RouteContext", () => ({
  useRoute: () => ({ navigateTo: jest.fn() }),
}));
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

beforeEach(() => {
  localStorage.clear(); localStorage.setItem("workflow.user", JSON.stringify({ id: "actor" }));
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name, _options, action) => action() } });
  jest.spyOn(crypto, "randomUUID").mockReturnValue("workflow-action-request-0001");
  jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: { can_attempt_run: true, operation_job_admission: "operation-job/v1" } } });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  notify.mockClear();
  localStorage.clear(); delete navigator.locks;
});

test("the detail page can hide the duplicate run control", () => {
  render(<WorkflowActions workflow={{ id: "wf_1", name: "Client echo" }} showRun={false} />);
  expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
});

test("queued admission is not described as finished, even when refreshing the list fails", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { success: true, data: { id: "exec_queued", workflowId: "wf_queued", status: "QUEUED" } } });
  const onChanged = jest.fn().mockRejectedValue(new Error("List refresh unavailable"));
  render(<WorkflowActions workflow={{ id: "wf_queued", name: "Queued report" }} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(notify).toHaveBeenCalledWith("Execution exec_queued was recorded, but this list could not refresh. Open Execution History to review it.", "warning"));
  expect(notify).toHaveBeenCalledWith("Execution exec_queued accepted with status QUEUED. Open Execution History to follow its progress.", "info");
  expect(notify.mock.calls.some(([message]) => /finished|Workflow run failed/.test(message))).toBe(false);
  expect(post).toHaveBeenCalledTimes(1);
});

test("validates runtime JSON and sends the parsed object to the execution endpoint", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({
    data: {
      success: true,
      data: {
        id: "exec_1",
        workflowId: "wf_1",
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
      mode: "async-operation", idempotencyKey: "workflow-action-request-0001", expectedActorId: "actor",
    }, { timeout: 300000 });
  });
  expect(notify).toHaveBeenCalledWith("Execution exec_1 finished with status DONE.", "success");
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test("renders failed rule details from a gate rejection", async () => {
  jest.spyOn(apiClient, "post").mockRejectedValue({
    response: {
      status: 422,
      data: {
        message: "Workflow failed full registry validation before execution",
        meta: {
          failed_rules: ["CAP-GAP-001"],
          errors: [{
            rule_id: "CAP-GAP-001",
            message: "Referenced tool is not active",
            step: "approve-order",
          }],
        },
      },
    },
  });

  render(<WorkflowActions workflow={{ id: "wf_1", name: "Client echo" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/CAP-GAP-001/);
  expect(alert.textContent).toMatch(/Referenced tool is not active/);
  expect(alert.textContent).toMatch(/step: approve-order/);
});

test("falls back to the top-level gate message when metadata is absent", async () => {
  jest.spyOn(apiClient, "post").mockRejectedValue({
    response: {
      status: 422,
      data: { message: "Workflow run was rejected" },
    },
  });

  render(<WorkflowActions workflow={{ id: "wf_1", name: "Client echo" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));

  expect((await screen.findByRole("alert")).textContent).toBe("Workflow run was rejected");
});

test("unsupported browser protection is explained without sending a run", async () => {
  delete navigator.locks; const post = jest.spyOn(apiClient, "post");
  render(<WorkflowActions workflow={{ id: "wf_1", name: "Client echo" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" })); fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Web Locks support/); expect(post).not.toHaveBeenCalled();
});
