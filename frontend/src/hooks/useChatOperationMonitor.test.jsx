/** @jest-environment jsdom */
import { jest, expect, test, beforeEach, afterEach } from "@jest/globals";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useChatOperationMonitor, reconcileChatProgress } from "./useChatOperationMonitor";
import { chatService } from "../services/chat.service";
const event = sequence => ({ version: 1, operationId: "job", sessionId: "chat", sequence, timestamp: "2026-10-05T00:00:00Z", type: "operation.stage", stage: "MODEL" });
const page = (events, status = "RUNNING", extra = {}) => ({ operation: { id: "job", sessionId: "chat", status, stage: "MODEL", attempts: [], lastSequence: events.at(-1)?.sequence ?? 0 }, events, nextCursor: events.at(-1)?.sequence ?? 0, hasMore: false, ...extra });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tick = async (ms = 1500) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { jest.useFakeTimers(); jest.spyOn(Math, "random").mockReturnValue(0.5); jest.spyOn(chatService, "operation").mockResolvedValue(page([event(1)])); jest.spyOn(chatService, "sendMessage"); });
afterEach(() => { cleanup(); jest.useRealTimers(); jest.restoreAllMocks(); });

test("restores progress by read only, drains terminal pages then stops", async () => {
  chatService.operation.mockResolvedValueOnce(page([event(1)], "ANSWERED", { operation: { id: "job", sessionId: "chat", status: "ANSWERED", attempts: [], lastSequence: 2 }, hasMore: true })).mockResolvedValue(page([event(2)], "ANSWERED"));
  const { result } = renderHook(() => useChatOperationMonitor("job")); await flush(); await tick(1);
  expect(result.current.events.map(entry => entry.sequence)).toEqual([1, 2]); expect(result.current.operation.status).toBe("ANSWERED");
  await tick(30000); expect(chatService.operation).toHaveBeenCalledTimes(2); expect(chatService.sendMessage).not.toHaveBeenCalled();
});
test("held read does not overlap; cleanup aborts the read without replay", async () => {
  let resolve; chatService.operation.mockImplementation(() => new Promise(done => { resolve = done; }));
  const { result, unmount } = renderHook(() => useChatOperationMonitor("job")); await flush(); await tick(30000);
  expect(chatService.operation).toHaveBeenCalledTimes(1); const signal = chatService.operation.mock.calls[0][2].signal;
  unmount(); expect(signal.aborted).toBe(true); resolve(page([event(1)])); await flush(); expect(result.current.operation).toBeNull(); expect(chatService.sendMessage).not.toHaveBeenCalled();
});
test("uses one abortable server-held progress read instead of freezing or overlapping requests", async () => {
  let resolve; chatService.operation.mockImplementation(() => new Promise(done => { resolve = done; }));
  const { unmount } = renderHook(() => useChatOperationMonitor("job", { waitMs: 25000 })); await flush(); await tick(30000);
  expect(chatService.operation).toHaveBeenCalledTimes(1);
  expect(chatService.operation.mock.calls[0][2]).toMatchObject({ waitMs: 25000 });
  unmount(); resolve(page([event(1)]));
});

test("fresh progress immediately reopens one held read, while unchanged pages retain the bounded interval", async () => {
  chatService.operation.mockResolvedValueOnce(page([event(1)])).mockResolvedValue(page([event(1)]));
  const { unmount } = renderHook(() => useChatOperationMonitor("job")); await flush(); await tick(1);
  expect(chatService.operation).toHaveBeenCalledTimes(2);
  expect(chatService.operation.mock.calls[1][1]).toBe(1);
  await tick(1000); expect(chatService.operation).toHaveBeenCalledTimes(2);
  await tick(500); expect(chatService.operation).toHaveBeenCalledTimes(3);
  expect(chatService.sendMessage).not.toHaveBeenCalled(); unmount();
});
test("gaps reset only the read cursor and reconnect beyond three network failures", async () => {
  chatService.operation.mockResolvedValueOnce(page([event(1)])).mockResolvedValueOnce(page([event(3)])).mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useChatOperationMonitor("job")); await flush(); await tick(); expect(result.current.cursor).toBe(0); expect(result.current.reconnecting).toBe(true);
  await tick(60000); expect(chatService.operation.mock.calls.length).toBeGreaterThan(4);
  chatService.operation.mockResolvedValue(page([event(1), event(2), event(3)], "ANSWERED"));
  act(() => window.dispatchEvent(new Event("online"))); await flush(); expect(chatService.operation.mock.calls.at(-1)[1]).toBe(0); expect(result.current.events).toHaveLength(3); expect(result.current.error).toBe(""); expect(chatService.sendMessage).not.toHaveBeenCalled();
});
test("authorization loss clears evidence and cannot be revived by online event", async () => {
  chatService.operation.mockResolvedValueOnce(page([event(1)])).mockRejectedValue({ response: { status: 403 } });
  const { result } = renderHook(() => useChatOperationMonitor("job")); await flush(); await tick();
  expect(result.current.denied).toBe(true); expect(result.current.operation).toBeNull(); expect(result.current.events).toEqual([]);
  act(() => window.dispatchEvent(new Event("online"))); await tick(60000); expect(chatService.operation).toHaveBeenCalledTimes(2);
});
test("an account scope change immediately hides the earlier frame and late response", async () => {
  chatService.operation.mockResolvedValueOnce(page([event(1)])).mockImplementation(() => new Promise(() => {}));
  const { result, rerender } = renderHook(({ scope }) => useChatOperationMonitor("job", { scope }), { initialProps: { scope: "owner-role-a" } }); await flush(); expect(result.current.operation).not.toBeNull();
  rerender({ scope: "owner-role-b" }); expect(result.current.operation).toBeNull(); expect(result.current.events).toEqual([]);
});
test("duplicate evidence must match and unrelated/corrupt evidence fails closed", () => {
  const saved = event(1); expect(reconcileChatProgress([saved], 1, page([saved]), "job").events).toHaveLength(1);
  for (const change of [{ stage: "READING" }, { sessionId: "other" }, { version: 2 }, { timestamp: "bad" }]) expect(() => reconcileChatProgress([saved], 1, page([{ ...saved, ...change }]), "job")).toThrow();
  expect(() => reconcileChatProgress([], 0, page([event(2)]), "job")).toThrow(/sequence gap/);
});
