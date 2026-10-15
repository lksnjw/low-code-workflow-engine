import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { captureAuthority, isAuthorityCurrent } from "../../utils/authAuthority";
import { chatErpActionsService } from "../../services/chat-erp-actions.service";
import { ReadableResult } from "./ReadableValue";
import { erpActionFields, erpActionLabel } from "./erpActionPresentation";

const labels = { PENDING: "Awaiting your confirmation", DISPATCH_INTENT: "Dispatch recorded · outcome pending", SUCCEEDED: "ERP response received", FAILED: "ERP returned an error", OUTCOME_UNKNOWN: "Outcome unconfirmed · do not repeat" };

/** Lazy review avoids per-message GETs during history loading. Lost write
 * responses expose only status retrieval, never an automatic retry. */
export default function ChatErpActionCard({ action: initial, onSaved, busy: chatBusy = false }) {
  const { user } = useAuth();
  const [action, setAction] = useState(initial), [busy, setBusy] = useState(false), [reviewed, setReviewed] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const [clock, setClock] = useState(Date.now);
  const deadline = Date.parse(action.expiresAt);
  const expired = action.expiresAt !== undefined && (!Number.isFinite(deadline) || deadline <= clock);
  useEffect(() => {
    if (action.status !== "PENDING" || !Number.isFinite(deadline)) return;
    const tick = setTimeout(() => { setClock(Date.now()); setConfirmed(false); }, Math.max(0, Math.min(deadline - Date.now() + 1, 2147483647)));
    return () => clearTimeout(tick);
  }, [action.status, deadline]);
  const owner = user?.id === action.ownerId && user?.role === "Platform Admin";
  const emailAction = /^Send (?:e ?mail|mail)$/i.test(erpActionLabel(action));
  const current = value => value?.profile === "erp-chat-action/v1" && value.id === initial.id && value.ownerId === user?.id && value.sessionId === initial.sessionId && value.reviewHash === initial.reviewHash;
  const refresh = async () => {
    if (inFlight.current || !owner) return;
    const authority = captureAuthority(user);
    if (!isAuthorityCurrent(authority)) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try {
      const result = await chatErpActionsService.get(action);
      if (!isAuthorityCurrent(authority)) return;
      if (!current(result)) throw new Error("ERP action identity changed. Reload this conversation.");
      setAction(result); setReviewed(true); setConfirmed(false);
    } catch (error) { if (isAuthorityCurrent(authority)) setNotice(error?.response?.data?.message || error?.message || "Current ERP action is unavailable."); }
    finally { inFlight.current = false; if (isAuthorityCurrent(authority)) setBusy(false); }
  };
  const execute = async () => {
    if (inFlight.current || !owner || !reviewed || !confirmed || uncertain || action.status !== "PENDING" || chatBusy || action.expiresAt !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now())) return;
    const authority = captureAuthority(user);
    if (!isAuthorityCurrent(authority)) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try {
      const result = await chatErpActionsService.execute(action, crypto.randomUUID());
      if (!isAuthorityCurrent(authority)) return;
      if (!current(result) || result.status === "PENDING") throw new Error("Execution confirmation is unverified. Refresh status; do not repeat this change.");
      setAction(result); setConfirmed(false); setUncertain(true);
      try { await onSaved?.(); } catch { setNotice("ERP action response saved. Reload this conversation if its new message is not visible."); }
    } catch (error) {
      if (isAuthorityCurrent(authority)) { setUncertain(true); setConfirmed(false); setNotice(error?.response?.data?.message || "Execution response is unconfirmed. Refresh status and retrieve the ERP record; do not submit the change again."); }
    } finally { inFlight.current = false; if (isAuthorityCurrent(authority)) setBusy(false); }
  };
  return <section aria-label="ERP change review" className="mt-4 space-y-3 rounded-xl border border-gray-200 p-4 text-sm dark:border-gray-700" aria-busy={busy}>
    <div><h3 className="font-semibold">{erpActionLabel(action)}</h3><p role="status" className="mt-1 text-xs text-gray-500">{expired && action.status === "PENDING" ? "Proposal expired · not executable" : !reviewed && action.status === "PENDING" ? "Recorded proposal · check current status" : labels[action.status] || "Status unavailable"}</p></div>
    <div className={emailAction ? "max-h-80 overflow-auto" : undefined} aria-label={emailAction ? "Exact email contents" : undefined}><ReadableResult value={erpActionFields(action)} /></div>
    <details><summary className="cursor-pointer text-xs text-primary">Technical details</summary><p className="mt-2 text-xs text-gray-500">Exact ERP operation: <code>{action.toolName}</code></p><ReadableResult value={action.arguments} /></details>
    {action.receipt && <details><summary className="cursor-pointer text-xs text-primary">ERP response</summary><ReadableResult value={action.receipt} /></details>}
    {owner && <div className="space-y-3">
      <button type="button" onClick={refresh} disabled={busy || chatBusy} className="rounded-md border px-3 py-2 text-xs disabled:opacity-50">{busy ? "Checking ERP action…" : reviewed || uncertain || action.status !== "PENDING" ? "Refresh action status" : emailAction ? "Review email" : "Review current action"}</button>
      {(reviewed || emailAction) && action.status === "PENDING" && !uncertain && !expired && <>
        {!reviewed && emailAction && <p className="text-xs text-gray-500">First choose “Review email” to check the current proposal. Then check the box and choose “Confirm and send email”. Nothing is sent by reviewing.</p>}
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || chatBusy || !reviewed} />{emailAction ? "I approve this exact recipient and email message." : "I approve these exact ERP fields. This changes ERP data, not a workflow."}</label>
        <button type="button" onClick={execute} disabled={busy || chatBusy || !reviewed || !confirmed} className="rounded-md bg-primary px-3 py-2 text-xs text-white disabled:opacity-50">{busy ? emailAction ? "Sending email…" : "Executing ERP change…" : emailAction ? "Confirm and send email" : "Confirm and execute"}</button>
        {emailAction && <p className="text-xs text-gray-500">This sends the reviewed message through ERPBridge. An acceptance response is not proof of inbox delivery; an unconfirmed send is never retried automatically.</p>}
      </>}
    </div>}
    {action.status === "PENDING" && expired && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">This proposal expired. Check current action status and the ERP record before asking in chat for a new proposal. This review cannot send another change.</p>}
    {notice && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{notice}</p>}
    {["DISPATCH_INTENT", "OUTCOME_UNKNOWN"].includes(action.status) && <p className="text-xs text-amber-700 dark:text-amber-300">Check the record in ERP before taking another action. This change cannot be blindly retried.</p>}
    {!owner && action.status === "PENDING" && <p className="text-xs text-gray-500">Only the requesting administrator can confirm this exact change.</p>}
  </section>;
}
