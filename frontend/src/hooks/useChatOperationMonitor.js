import { useCallback, useEffect, useState } from "react";
import { chatService } from "../services/chat.service";

export const isActiveChatOperation = status => ["QUEUED", "RUNNING"].includes(status);
export function reconcileChatProgress(previous, cursor, page, operationId) {
  const operation = page?.operation;
  if (operation?.id !== operationId || !Array.isArray(page.events) || page.events.length > 100 ||
      !Number.isSafeInteger(operation.lastSequence) || !Number.isSafeInteger(page.nextCursor) ||
      typeof page.hasMore !== "boolean" || !Array.isArray(operation.attempts) || operation.attempts.length > 64 ||
      !["QUEUED", "RUNNING", "ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(operation.status)) throw new Error("Chat progress response is invalid");
  const events = [...previous]; let next = cursor;
  for (const entry of page.events) {
    if (entry?.version !== 1 || entry.operationId !== operationId || entry.sessionId !== operation.sessionId || !Number.isSafeInteger(entry.sequence) || entry.sequence <= 0 || entry.sequence > operation.lastSequence || typeof entry.type !== "string" || typeof entry.stage !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) throw new Error("Chat progress has unrelated evidence");
    if (entry.sequence <= next) {
      if (JSON.stringify(events.find(event => event.sequence === entry.sequence)) !== JSON.stringify(entry)) throw new Error("Chat progress has conflicting evidence");
      continue;
    }
    if (entry.sequence !== next + 1) throw new Error("Chat progress has a sequence gap");
    events.push(entry); next = entry.sequence;
  }
  if (next !== page.nextCursor || next < cursor || next > operation.lastSequence || page.hasMore !== (next < operation.lastSequence) || events.length > 2000)
    throw new Error("Chat progress cursor is inconsistent");
  return { events, cursor: next, operation };
}

// Reconnect only reads acknowledged operations. It never resubmits a message.
export function useChatOperationMonitor(operationId, { interval = 1500, waitMs = 25000, scope = "" } = {}) {
  const [frame, setFrame] = useState(null), [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    if (!operationId) return undefined;
    const controller = new AbortController(); let disposed = false, timer, cursor = 0, events = [], current = null, failures = 0, inFlight = false, stopped = false;
    const poll = async () => {
      if (disposed || stopped || inFlight) return; inFlight = true;
      let again = true, delay = interval;
      try {
        if (navigator.onLine === false) throw new Error("Browser is offline");
        // Firebase-safe SSE-like delivery: the server holds this authenticated
        // cursor read until progress changes. Teardown aborts it; reconnects
        // only read saved evidence and never resubmit the chat command.
        const page = await chatService.operation(operationId, cursor, { signal: controller.signal, waitMs });
        if (disposed) return;
        const next = reconcileChatProgress(events, cursor, page, operationId);
        // Reopen the next held read immediately after genuine new progress.
        // The old fixed interval added 1.5 seconds after every stage update.
        // Duplicate/no-progress replies still back off; never replay commands.
        delay = next.cursor > cursor && (page.hasMore || isActiveChatOperation(next.operation.status)) ? 0 : page.waited === true && isActiveChatOperation(next.operation.status) ? 0 : interval;
        current = next.operation; cursor = next.cursor; events = next.events; failures = 0;
        again = page.hasMore || isActiveChatOperation(current.status);
        setFrame({ id: operationId, scope, operation: current, events, cursor, error: "", denied: false, reconnecting: false });
      } catch (error) {
        if (disposed) return;
        failures++; const denied = [401, 403, 404].includes(error?.response?.status);
        if (denied) { current = null; events = []; }
        if (!denied && /sequence gap/i.test(error?.response?.data?.message || error?.message || "")) { cursor = 0; events = []; }
        setFrame({ id: operationId, scope, operation: current, events, cursor, error: denied ? "This operation is no longer available to this account." : "Progress is unavailable. Reconnecting to saved evidence; no message will be resubmitted.", denied, reconnecting: !denied });
        again = !denied; delay = Math.min(30000, interval * 2 ** Math.min(5, failures - 1) * (0.85 + Math.random() * 0.3));
      }
      inFlight = false; stopped = !again;
      if (!disposed && again) timer = setTimeout(poll, delay);
    };
    const reconnect = () => { if (!disposed && !stopped && !inFlight) { clearTimeout(timer); void poll(); } };
    const visible = () => { if (document.visibilityState === "visible") reconnect(); };
    window.addEventListener("online", reconnect); document.addEventListener("visibilitychange", visible); void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", reconnect); document.removeEventListener("visibilitychange", visible); };
  }, [operationId, interval, waitMs, generation, scope]);
  const active = frame?.id === operationId && frame?.scope === scope ? frame : null;
  return { operation: active?.operation ?? null, events: active?.events ?? [], cursor: active?.cursor ?? 0, error: active?.error ?? "", denied: active?.denied ?? false, reconnecting: active?.reconnecting ?? false, refresh };
}
