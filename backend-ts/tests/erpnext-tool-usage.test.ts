import { expect, test } from "vitest";
import { QUERY_SYSTEM_PROMPT, ACTION_SYSTEM_PROMPT, ERP_QUERY_SYSTEM_PROMPT, ERP_ACTION_SYSTEM_PROMPT, systemInstructionsFor } from "../src/prompts/contracts.js";

test.each([ERP_QUERY_SYSTEM_PROMPT, ERP_ACTION_SYSTEM_PROMPT, systemInstructionsFor("prompt/candidate/v21")])("ERP usage guidance reaches current governed prompt families without granting catalog authority", prompt => {
  expect(prompt).toContain("ERPBRIDGE / ERPNEXT TOOL USAGE");
  expect(prompt).toContain("offered in the current operation");
  expect(prompt).toContain("never");
  expect(prompt).toContain("A tool guide, naming convention, or full server catalog does not grant access");
  expect(prompt).toContain("Utility getters such as get_current_user, get_user_details and get_value have different schemas");
  expect(prompt).toContain("Never use 0 for unlimited retrieval");
  expect(prompt).toContain("A page length is not the full record count");
  expect(prompt).toContain("Call ERP tools sequentially");
  expect(prompt).toContain("JSON-encoded strings rather than native objects/arrays");
  expect(prompt).toContain("Writes require an explicit reviewed contract");
  expect(prompt).toContain("not necessarily the current platform user or a reviewer");
  expect(prompt).not.toContain("Serendib Consumer Products");
});

test("historical prompts stay immutable and do not acquire new guide instructions", () => {
  for (const prompt of [QUERY_SYSTEM_PROMPT, ACTION_SYSTEM_PROMPT, systemInstructionsFor("prompt/candidate/v20")])
    expect(prompt).not.toContain("ERPBRIDGE / ERPNEXT TOOL USAGE");
});
