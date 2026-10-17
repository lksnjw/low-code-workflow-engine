/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PublishedWorkflowRunForm from "./PublishedWorkflowRunForm";
afterEach(cleanup);

test("read-and-model publication has truthful read-only wording and keeps controls gated", () => {
  const run = jest.fn();
  render(<PublishedWorkflowRunForm record={{ executionProfile: "sequential-operation-v1", effectProfile: "read-only", operation_job_admission: "operation-job/v1" }} runInput={{}} onInput={jest.fn()} onRun={run} submitting disabled unconfirmed />);
  expect(screen.getByText("Run saved read-and-model workflow")).toBeTruthy();
  expect(screen.getByText(/no ERP write or notification is part/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Results require saved acknowledgements");
  expect(screen.getByRole("button", { name: "Run saved steps" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Run saved steps" })); expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: /outcome unconfirmed/ }).getAttribute("href")).toBe("/executions");
});

test.each(["contains-effects", "unknown", undefined])("non-read-only operation %s retains independent approval wording", effectProfile => {
  render(<PublishedWorkflowRunForm record={{ executionProfile: "sequential-operation-v1", effectProfile }} runInput={{}} onInput={jest.fn()} onRun={jest.fn()} />);
  expect(screen.getByText("Run saved operation workflow")).toBeTruthy();
  expect(screen.getByText(/Every write waits for independent exact approval/)).toBeTruthy();
  expect(screen.queryByText(/no ERP write or notification is part/)).toBeNull();
});

test.each(["protected-operation-v1", "protected-draft-runtime-pending"])("protected profile %s retains operation policy and server run gating", executionProfile => {
  const run = jest.fn(); render(<PublishedWorkflowRunForm record={{ executionProfile, effectProfile: "contains-effects", operation_job_admission: "operation-job/v1" }} runInput={{}} onInput={jest.fn()} onRun={run} disabled submitting />);
  expect(screen.getByText("Run saved operation workflow")).toBeTruthy(); expect(screen.getByText(/Every write waits for independent exact approval/)).toBeTruthy();
  expect(screen.getByText(/Draft eligibility does not grant permission to run/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Each write requires independent approval");
  fireEvent.click(screen.getByRole("button", { name: "Run saved steps" })); expect(run).not.toHaveBeenCalled();
});

test("read-only protected publication does not incorrectly promise a write or notification", () => {
  render(<PublishedWorkflowRunForm record={{ executionProfile: "protected-operation-v1", effectProfile: "read-only", operation_job_admission: "operation-job/v1" }} runInput={{}} onInput={jest.fn()} onRun={jest.fn()} submitting />);
  expect(screen.getByText("Run saved read-and-model workflow")).toBeTruthy(); expect(screen.getByRole("status").textContent).toContain("no ERP write or notification");
});
