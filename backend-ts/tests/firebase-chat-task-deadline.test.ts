import { expect, test } from "vitest";
import { firebaseChatTaskDeadlineMs } from "../src/firebase/chat-task-deadline.js";
import { loadConfig } from "../src/config/config.js";
test("phased chat gets an explicit bounded overall budget, not the old fixed 60 seconds", () => {
  expect(firebaseChatTaskDeadlineMs()).toBe(180_000);
  expect(firebaseChatTaskDeadlineMs(60_000)).toBe(60_000);
  expect(firebaseChatTaskDeadlineMs(240_000)).toBe(240_000);
  expect(loadConfig({ APP_ENV: "test", JWT_SECRET: "local-test-secret-123456789", FUNCTIONS_CHAT_TASK_TIMEOUT_MS: "120000" }).functionsChatTaskTimeoutMs).toBe(120_000);
});
test.each([999, 240001, 1000.5, NaN, Infinity])("invalid chat budget %s fails closed", value => {
  expect(() => firebaseChatTaskDeadlineMs(value)).toThrow("FUNCTIONS_CHAT_TASK_TIMEOUT_MS");
});
