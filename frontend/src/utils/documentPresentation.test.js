import { expect, test } from "@jest/globals";
import { documentNotice } from "./documentPresentation";

test("document notices hide extraction provider identities without inventing OCR success", () => {
  const text = documentNotice("google/gemini-3.8-flash and deepseek/deepseek-v4.1-flash: model-only preview; OCR not confirmed.");
  expect(text).not.toMatch(/gemini|deepseek/i);
  expect(text).toContain("provisional preview");
  expect(text).toContain("OCR not confirmed");
});
test("configured extraction identity can be removed without changing business fields", () => {
  expect(documentNotice("private-provider/vision-v1 unavailable", "private-provider/vision-v1")).toBe("document reader unavailable");
  expect(documentNotice("Customer name is required.")).toBe("Customer name is required.");
});
