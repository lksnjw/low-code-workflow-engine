import { expect, test } from "vitest";
import { generationPromptHash, systemInstructionsFor } from "../src/prompts/contracts.js";
import { CANDIDATE_PROMPT_VERSION } from "../src/providers/runtime.js";

test("reusable form authoring uses declared runtime fields, not the example record", () => {
  expect(CANDIDATE_PROMPT_VERSION).toBe("prompt/candidate/v23");
  const current = systemInstructionsFor(CANDIDATE_PROMPT_VERSION);
  expect(current).toContain("REUSABLE DOCUMENT-BASED RUN INPUTS");
  expect(current).toContain("trigger.config.inputSchema");
  expect(current).toContain("{{input.field}}");
  expect(current).toContain("not an executable OCR node");
  expect(current).toContain("A single-record workflow cannot silently consume");
  expect(current).toContain("exact runtime approvals remain enforced");
});
test("historical candidate source and provenance remain distinct", () => {
  expect(systemInstructionsFor("prompt/candidate/v22")).not.toContain("REUSABLE DOCUMENT-BASED RUN INPUTS");
  expect(generationPromptHash("same", "prompt/candidate/v23")).not.toBe(generationPromptHash("same", "prompt/candidate/v22"));
});
