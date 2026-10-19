import { expect, test } from "@jest/globals";
import { documentWorkflowRequest, modelPreviewRequest } from "./documentWorkflowRequest";

test("document workflow request preserves the user's business outcome without executing it", () => {
  const text = documentWorkflowRequest("Add these clients to the ERP after checking duplicate emails.");
  expect(text).toContain("Add these clients to the ERP after checking duplicate emails.");
  expect(text).toContain("preserve every reviewed row");
  expect(text).toContain("same workflow and tools");
  expect(text).toContain("do not execute ERP operations");
  expect(text).toContain("Do not activate a schedule");
});

test("model-only preview can support normal chat or explicit workflow drafting without claiming pipeline evidence", () => {
  const preview = { fields: { customer_name: "Example" }, rows: [{ customer_name: "Second" }], warnings: ["Partial"], sourceContentHash: "sha", model: "google/gemini-3.8-flash" };
  const chat = modelPreviewRequest(preview, "Add these clients");
  expect(chat).toContain("Do not generate a workflow"); expect(chat).toContain("not OCR-confirmed data"); expect(chat).toContain("current ERPBridge contracts");
  expect(chat).not.toContain("google/gemini-3.8-flash"); expect(chat).not.toContain('"model":');
  const draft = modelPreviewRequest(preview, "Create a customer workflow", true, true);
  expect(draft).toContain("Create an editable reusable ERP record-creation workflow"); expect(draft).toContain("eligible for scheduling");
  expect(draft).toContain('"customer_name":"Second"'); expect(draft).toContain("Partial");
});
test("scheduling handoff asks for the missing details and cannot enable repeated imports", () => {
  const text = documentWorkflowRequest("Prepare the customer import", true);
  expect(text).toContain("eligible for scheduling"); expect(text).toContain("timezone");
  expect(text).toContain("Do not activate a schedule"); expect(text).toContain("repeatedly import the same client list");
});
test("the handoff is bounded and does not require browser-authored document fields", () => {
  expect(documentWorkflowRequest("x".repeat(3000))).not.toContain("x".repeat(2001));
  expect(documentWorkflowRequest()).toContain("selected reviewed forms");
});
