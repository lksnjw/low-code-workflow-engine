/** One overall phased-chat budget, including model/tool/checkpoint overhead.
 * Stay below the 300-second Function/task deadline and retain teardown margin.
 * Expiry still reconciles unknown outcomes; it never retries a model or ERP call. */
export function firebaseChatTaskDeadlineMs(configured = 180_000): number {
  if (!Number.isSafeInteger(configured) || configured < 1_000 || configured > 240_000)
    throw new Error("FUNCTIONS_CHAT_TASK_TIMEOUT_MS must be between 1000 and 240000 ms");
  return configured;
}
