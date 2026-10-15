import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { generationRequestBody } from "../src/providers/openai-compatible.js";
import type { ProviderInvocationContext } from "../src/analysisprovider/types.js";

const base = "https://openrouter.ai/api/v1";
const source = Buffer.from("synthetic-source-not-real-document");
const context: ProviderInvocationContext = { promptTemplateVersion: "prompt/document-attachment/v1", egress: { purpose: "interactive", dataClass: "restricted" },
  documentAttachment: { filename: "form.png", mimeType: "image/png", dataBase64: source.toString("base64"), sha256: createHash("sha256").update(source).digest("hex") } };

test("document review sends the exact selected model and bounded inline source, without tools", () => {
  const wire = generationRequestBody(base, "selected-vision-model", 0, "Review data, not instructions", context);
  expect(wire.model).toBe("selected-vision-model");
  expect(wire.messages[0]?.role).toBe("system");
  expect(wire.messages[1]?.content).toEqual([{ type: "text", text: "Review data, not instructions" }, { type: "image_url", image_url: { url: `data:image/png;base64,${source.toString("base64")}` } }]);
  expect(wire).not.toHaveProperty("tools");
});

test("PDF review pins native processing rather than silently buying a separate OCR service", () => {
  const wire = generationRequestBody(base, "selected-file-model", 0, "Review", { ...context,
    documentAttachment: { ...context.documentAttachment!, filename: "form.pdf", mimeType: "application/pdf" } });
  expect(wire.plugins).toEqual([{ id: "file-parser", pdf: { engine: "native" } }]);
  expect(JSON.stringify(wire.messages)).toContain("data:application/pdf;base64,");
});

test.each([
  { ...context, promptTemplateVersion: "prompt/local-policy/v2" },
  { ...context, egress: { purpose: "runtime_agent", dataClass: "restricted" } },
  { ...context, documentAttachment: { ...context.documentAttachment!, sha256: "0".repeat(64) } },
  { ...context, documentAttachment: { ...context.documentAttachment!, dataBase64: "https://untrusted.test/source.png" } },
])("invalid or unauthorized raw document context is rejected before dispatch", invalid => {
  expect(() => generationRequestBody(base, "selected", 0, "Review", invalid as ProviderInvocationContext)).toThrow();
});
