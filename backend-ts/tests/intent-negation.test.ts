import { expect, test } from "vitest";
import { classifyIntent } from "../src/agent/intent-classifier.js";

test.each([
  "Retrieve the employee certificate. Do not generate a workflow.",
  "Do not upload, modify, approve or generate a workflow; show me the stored document.",
  "Don't create a wrok flow. Retrieve EMP-QA-1042.",
  "Do NOT send it to canvas; list invoices instead.",
  "Never automate this; just show the purchase orders.",
])("negative workflow instructions remain queries: %s", text => {
  expect(classifyIntent(text)).toBe("QUERY");
});
test.each([
  "Create a workflow to retrieve certificates. Do not send email.",
  "Do not approve invoices, but generate a workflow to review them.",
  "Don't upload documents. Generate a wrok flow to retrieve them.",
])("an affirmative workflow clause still creates only a proposal: %s", text => {
  expect(classifyIntent(text)).toBe("ACTION");
});
