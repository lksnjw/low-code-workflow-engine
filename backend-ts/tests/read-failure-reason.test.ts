import { expect, test } from "vitest";
import { readFailureReason } from "../src/runner/read-failure-reason.js";
test("read failures expose bounded categories, never raw messages or a replay grant", () => {
  expect(readFailureReason(new Error("Tool dispatch denied: tool has no unique admitted live contract"))).toBe("READ_CAPABILITY_UNAVAILABLE");
  expect(readFailureReason(new Error("Tool dispatch denied: deterministic verification failed"))).toBe("READ_VALIDATION_FAILED");
  expect(readFailureReason(new Error("ERPBridge output does not match its reviewed output schema"))).toBe("READ_OUTPUT_SCHEMA_MISMATCH");
  expect(readFailureReason(new Error("Untrusted api_key=private-secret"))).toBe("READ_EXECUTION_FAILED");
  expect(readFailureReason({ message: "Tool dispatch denied: deterministic verification failed" })).toBe("READ_EXECUTION_FAILED");
});
