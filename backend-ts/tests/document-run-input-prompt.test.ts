import { expect, test } from "vitest";
import { generationPromptHash, systemInstructionsFor } from "../src/prompts/contracts.js";
import { CANDIDATE_PROMPT_VERSION } from "../src/providers/runtime.js";

test("reusable form authoring uses declared runtime fields, not the example record", () => {
  expect(CANDIDATE_PROMPT_VERSION).toBe("prompt/candidate/v28");
  const current = systemInstructionsFor(CANDIDATE_PROMPT_VERSION);
  expect(current).toContain("REUSABLE DOCUMENT-BASED RUN INPUTS");
  expect(current).toContain("trigger.config.inputSchema");
  expect(current).toContain("{{input.field}}");
  expect(current).toContain("not an executable OCR node");
  expect(current).toContain("A single-record workflow cannot silently consume");
  expect(current).toContain("exact runtime approvals remain enforced");
  expect(current).toContain("MULTIPLE FORMS AND REPEATED SAVED RUNS");
  expect(current).toContain("never requires a new revision or publication");
  expect(current).toContain("Fresh exact human transaction approval");
});
test("plain onboarding separates runtime safeguards from requested extra ERP records", () => {
  for (const version of [CANDIDATE_PROMPT_VERSION, "prompt/workflow-modifier/v6"]) {
    const prompt = systemInstructionsFor(version);
    expect(prompt).toContain("do not imply a requested Contact or Address creation");
    expect(prompt).toContain("Do not turn them into unresolved requirements");
    expect(prompt).toContain("A policy rejection still stops dispatch");
    expect(prompt).toContain("Never erase genuine unresolved requirements");
  }
  expect(systemInstructionsFor("prompt/candidate/v25")).not.toContain("DOCUMENT ONBOARDING AND BACKEND-OWNED CHECKS");
});
test("historical candidate source and provenance remain distinct", () => {
  expect(systemInstructionsFor("prompt/candidate/v22")).not.toContain("REUSABLE DOCUMENT-BASED RUN INPUTS");
  expect(generationPromptHash("same", "prompt/candidate/v23")).not.toBe(generationPromptHash("same", "prompt/candidate/v22"));
});
