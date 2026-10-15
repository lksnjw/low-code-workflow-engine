// Presentation only: keep provider identities out of document-processing
// notices. Never alter extracted business fields, receipts or server routing.
export function documentNotice(value, modelId) {
  let text = typeof value === "string" ? value : "";
  if (typeof modelId === "string" && modelId) text = text.split(modelId).join("document reader");
  return text.replace(/\b(?:google\/)?gemini[\w./:-]*/gi, "document reader")
    .replace(/\b(?:deepseek\/)?deepseek[\w./:-]*/gi, "document reader")
    .replace(/\b(?:qwen\/)?qwen[\w./:-]*/gi, "document reader")
    .replace(/\bmodel[- ]only\b/gi, "provisional")
    .replace(/\bmodel[- ]interpreted\b/gi, "provisional")
    .replace(/\bmodel interpretation\b/gi, "provisional reading");
}
