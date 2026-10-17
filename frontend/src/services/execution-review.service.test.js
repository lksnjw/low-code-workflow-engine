import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { getReviewInbox, validateReviewInbox } from "./execution-review.service";
import { executionService } from "./execution.service";
afterEach(() => jest.restoreAllMocks());
const row = { executionId: "run/one", reviewId: "review-one", kind: "approval", reviewView: "approval", requestedAt: "2026-10-06T10:00:00.000Z", state: "open", workflowName: "Manager report",
  requesterName: "Requester", executionStatus: "AWAITING_APPROVAL", canResume: false, noReplay: true, nodeId: "send", toolName: "Send report",
  expiresAt: "2026-10-06T11:00:00.000Z", statusLabel: "Awaiting decision", reviewAvailable: true, actionable: true, detail: "Open the exact review." };
const page = () => ({ profile: "execution-review-inbox/v1", kind: "all", state: "open", scopes: { approval: true, reconciliation: false },
  items: [{ ...row }], nextCursor: null, hasMore: false, asOf: "2026-10-06T10:01:00.000Z", canResume: false, noReplay: true });

test("scheduled occurrence time is optional metadata and must be a valid date when provided", () => {
  const value = page(); value.items[0].scheduledFor = "2026-10-06T01:00:00Z";
  expect(validateReviewInbox(value).items[0].scheduledFor).toBe("2026-10-06T01:00:00Z");
  value.items[0].scheduledFor = "not-a-date";
  expect(() => validateReviewInbox(value)).toThrow(/inconsistent tasks/);
});
test("inbox requests only its read endpoint with filter/cursor and cancellation signal", async () => {
  const data = page(), params = { kind: "all", state: "open", limit: 25, cursor: "signed-cursor" }, signal = new AbortController().signal;
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data } });
  expect(await getReviewInbox(params, signal)).toEqual(data); expect(get).toHaveBeenCalledWith("/execution-reviews", { params, signal });
});
test("two historical decisions from the same run remain distinct, and their exact historical ID is checked before display", async () => {
  const data = page(); data.items.push({ ...row, reviewId: "earlier-review" }); expect(validateReviewInbox(data).items).toHaveLength(2);
  const value = { id: "run/one", runtimeApproval: { profile: "runtime-approval/v1", id: "earlier-review", state: "CONSUMED", version: 3,
    reviewHash: `sha256:${"a".repeat(64)}`, canDecide: false, canResume: false, arguments: { recipient: "manager@example.test" } } };
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: value } });
  expect(await executionService.getApproval("run/one", "earlier-review")).toEqual(value);
  expect(get).toHaveBeenCalledWith("/executions/run%2Fone", { params: { view: "approval", approvalId: "earlier-review" } });
  get.mockResolvedValue({ data: { success: true, data: { ...value, runtimeApproval: { ...value.runtimeApproval, id: "different-review" } } } });
  await expect(executionService.getApproval("run/one", "earlier-review")).rejects.toThrow(/Exact transaction review/);
});

test.each(["open", "closed"])("protected exact-item %s inbox rows retain approval routing without becoming dispatch authority", state => {
  const data = page(); data.state = state;
  Object.assign(data.items[0], { reviewView: "protected-approval", state, actionable: state === "open" });
  expect(validateReviewInbox(data, { state }).items[0].reviewView).toBe("protected-approval");
  data.items[0].kind = "reconciliation"; data.scopes.reconciliation = true;
  expect(() => validateReviewInbox(data, { state })).toThrow(/inbox/i);
});
test.each(["profile", "scope", "filter", "date", "duplicate", "cursor", "resume", "action", "size"])("inbox rejects inconsistent %s responses instead of claiming an empty list or an actionable task", scenario => {
  const data = page();
  if (scenario === "profile") data.profile = "wrong";
  if (scenario === "scope") data.scopes.approval = false;
  if (scenario === "filter") data.items[0].state = "closed";
  if (scenario === "date") data.items[0].requestedAt = "not-a-date";
  if (scenario === "duplicate") data.items.push({ ...data.items[0] });
  if (scenario === "cursor") data.hasMore = true;
  if (scenario === "resume") data.canResume = true;
  if (scenario === "action") { data.items[0].reviewAvailable = false; data.items[0].actionable = true; }
  if (scenario === "size") data.items = Array.from({ length: 51 }, (_, index) => ({ ...row, executionId: `run-${index}` }));
  expect(() => validateReviewInbox(data)).toThrow(/inbox/i);
});
