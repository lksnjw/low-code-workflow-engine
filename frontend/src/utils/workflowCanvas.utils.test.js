/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";

jest.unstable_mockModule("@xyflow/react", () => ({
  MarkerType: { ArrowClosed: "arrow-closed" },
}));

const {
  saveWorkflowForCanvas,
  takeWorkflowForCanvas,
  workflowCreationPayload,
  workflowYamlToCanvas,
} = await import("./workflowCanvas.utils");

afterEach(() => localStorage.clear());

test("chat origin survives the canvas handoff and enters the workflow creation payload", () => {
  const pending = {
    yaml: "name: linked\ntrigger:\n  type: manual\nsteps: []\n",
    candidateId: "candidate-1",
    canExecute: true,
    chatSessionId: "chat-1",
    chatMessageId: "msg-1",
    traceId: "4dfac97d-52c4-4f29-b09b-e2f60f7c89dc",
  };
  saveWorkflowForCanvas(pending);

  const received = takeWorkflowForCanvas();
  const canvas = workflowYamlToCanvas(received.yaml, received);
  const payload = workflowCreationPayload(canvas.workflow, received.yaml);

  expect(payload).toMatchObject({
    yaml: pending.yaml,
    chatSessionId: "chat-1",
    chatMessageId: "msg-1",
    traceId: "4dfac97d-52c4-4f29-b09b-e2f60f7c89dc",
  });
  expect(takeWorkflowForCanvas()).toBeNull();
});

test("ordinary canvas workflows do not gain chat correlation fields", () => {
  expect(
    workflowCreationPayload(
      { name: "Manual", description: "Created directly" },
      "name: manual",
    ),
  ).toEqual({
    name: "Manual",
    description: "Created directly",
    yaml: "name: manual",
  });
});
