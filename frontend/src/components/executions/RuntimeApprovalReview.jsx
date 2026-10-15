import { useState } from "react";
import ReadableValue from "../chat/ReadableValue";
import { executionService } from "../../services/execution.service";
import { validProtectedApprovalReview } from "../../services/protected-approval-review";

// An incomplete display never gets an enabled decision button. Backend
// identity/hash/policy checks remain independently mandatory.
export function completeApprovalDisplay(value) {
  let count = 0;
  const visit = (item, depth) => {
    if (++count > 500 || depth >= 8) return false;
    if (typeof item === "string") return item.length <= 12000;
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return true;
    if (!item || typeof item !== "object" || Object.keys(item).length > 25) return false;
    return Object.values(item).every(child => visit(child, depth + 1));
  };
  return visit(value, 0);
}
export default function RuntimeApprovalReview({ execution, onReload, onDecisionRecorded }) {
  const review = execution.runtimeApproval;
  const protectedItem = review.profile === "protected-approval/v1";
  const scopeComplete = !protectedItem || validProtectedApprovalReview(review, execution.status);
  const selectedItem = protectedItem && scopeComplete ? review.iterations.map(frame => `${frame.loopId} · item ${frame.index + 1}`).join(" → ") : null;
  const stateLabel = review.state === "CLOSED" ? "Closed — not dispatched" : review.state === "EXPIRED" ? "Expired — not dispatched"
    : protectedItem && review.state === "APPROVED" ? "Approved — not dispatched" : review.state;
  const [note, setNote] = useState(""), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState(null), [confirmed, setConfirmed] = useState(false), [showReject, setShowReject] = useState(false);
  const operationVisible = typeof review.toolName === "string" && review.toolName.trim().length > 0 && typeof review.remoteToolName === "string" && review.remoteToolName.trim().length > 0;
  const payloadComplete = completeApprovalDisplay(review.arguments);
  const complete = operationVisible && payloadComplete && scopeComplete;
  const available = review.canDecide === true && complete && !busy && !uncertain && !receipt;
  const reload = async () => {
    setBusy(true);
    try { await onReload(); setUncertain(false); setNotice("Authoritative review reloaded. Check its current decision and details."); }
    catch { setNotice("Review reload failed. No decision was retried; keep this review locked until reload succeeds."); }
    finally { setBusy(false); }
  };
  const decide = async outcome => {
    if (!available || outcome === "approve" && !confirmed) return;
    const command = { approvalId: review.id, baseVersion: review.version, reviewHash: review.reviewHash, decisionKey: crypto.randomUUID(), note };
    setBusy(true);
    try {
      const result = await executionService[outcome](execution.id, command);
      if (result?.approvalId !== review.id || result.executionId !== execution.id || result.canResume !== false || !["APPROVED", "REJECTED", "CONSUMED"].includes(result.state)) throw new Error("Unconfirmed decision response");
      setReceipt(result); setNotice(result.state === "REJECTED" ? "Exact transaction rejected. This checkpoint did not dispatch its operation." : result.operationManaged === true ? "Exact approval saved. The operation worker rechecks authority before dispatch. Check run history for the actual outcome; this receipt does not confirm delivery." : "Exact approval saved. This is not resumed, sent or completed; safe effect dispatch remains unavailable.");
      onDecisionRecorded?.(result);
      try { await onReload(); } catch { setNotice("Decision was acknowledged, but refreshing its review failed. Reload to see current state; do not submit it again."); }
    } catch (error) {
      const status = error?.response?.status;
      if ([403, 409, 422].includes(status)) setNotice(`${error?.response?.data?.message || "Decision denied or review changed."} Reload the exact review before deciding again.`);
      else setNotice("Decision acknowledgement is unknown. Reload authoritative state before another decision. Nothing was automatically retried.");
      setUncertain(true);
    } finally { setBusy(false); }
  };
  return <section className="min-w-0 space-y-5 text-gray-900 dark:text-gray-100" aria-label="Exact transaction review">
    <div><h1 className="page-heading text-gray-950 dark:text-white">Review transaction</h1><p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{execution.workflowName} · {review.nodeId}</p></div>
    <div className="border-y border-gray-200 py-4 dark:border-gray-700">
      <p className="text-sm font-semibold">{receipt?.state || stateLabel} · revision {receipt?.version || review.version}</p>
      <p className="mt-2 text-sm">{review.reason}</p><p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{review.resumeReason}</p>
      {review.selfApprovalAllowed === true && <p className="mt-2 text-sm font-medium">As Super Admin, you may confirm your own exact transaction. Review the details below; nothing is approved automatically.</p>}
    </div>
    {protectedItem && <div className="space-y-1 text-sm"><h2 className="font-semibold">Selected workflow item</h2>
      <p>{scopeComplete ? selectedItem || "Outside a collection" : "Item details unavailable"}</p><p className="text-xs text-gray-500 dark:text-gray-400">This decision applies only to this exact invocation and its displayed arguments, not other items.</p></div>}
    <dl className="grid gap-4 text-xs sm:grid-cols-2">
      {Object.entries({ Tool: review.toolName || "Unavailable", "Exact remote tool": review.remoteToolName || "Unavailable", Requester: review.requesterId, Connection: review.connectionId, Invocation: review.invocationId, "Capability revision": review.capabilityRevision,
        "Review expires": review.expiresAt, "Approver role": review.approverRole }).map(([label, value]) => <div key={label}><dt className="text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{value}</dd></div>)}
    </dl>
    <div><h2 className="mb-3 text-sm font-semibold">Exact business arguments</h2><ReadableValue value={review.arguments} /></div>
    {!operationVisible && <p className="text-sm text-amber-700 dark:text-amber-300">The exact tool identity is unavailable. Decisions are disabled; a node label alone does not identify an operation.</p>}
    {operationVisible && !payloadComplete && <p className="text-sm text-amber-700 dark:text-amber-300">This payload exceeds the complete display limits. Decisions are disabled; a shortened preview is not a full transaction review.</p>}
    {!scopeComplete && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">The exact workflow item or review lifecycle is incomplete. Decisions are disabled; reload the authoritative review.</p>}
    {review.unavailable && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{review.unavailable}</p>}
    {review.decision && <p className="text-sm">{review.decision.outcome} by {review.decision.actorId} · {review.decision.decidedAt}</p>}
    {review.closure && <p className="text-sm">{review.closure.status === "CANCELLED" ? "Cancelled before dispatch" : "Authorization or workflow changed before dispatch"} · {review.closure.closedAt}</p>}
    {review.expiredAt && <p className="text-sm">Original review deadline expired before dispatch · {review.expiredAt}</p>}
    {notice && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{notice}</p>}
    {review.state === "PENDING" && <div className="space-y-3">
      <label className="block text-xs text-gray-500 dark:text-gray-400">Decision note<textarea aria-label="Decision note" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} disabled={!available}
        className="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm dark:border-gray-700" /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!available} />{review.operationManaged === true ? "I reviewed these exact details and authorize this operation to be queued for fresh checks and execution. Approval is not delivery confirmation." : "I reviewed these exact details and understand that approval does not send or execute."}</label>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-white transition-opacity disabled:opacity-40" disabled={!available || !confirmed} onClick={() => decide("approve")}>Record approval</button>
        <button type="button" className="rounded-md border border-gray-200 px-4 py-2 text-sm transition-colors hover:bg-primary/5 disabled:opacity-40 dark:border-gray-700" disabled={!available} onClick={() => setShowReject(!showReject)}>Reject transaction</button>
        {showReject && <button type="button" className="rounded-md px-4 py-2 text-sm text-red-700 disabled:opacity-40 dark:text-red-300" disabled={!available} onClick={() => decide("reject")}>Confirm rejection</button>}
      </div>
    </div>}
    <button type="button" className="text-sm font-semibold text-primary disabled:opacity-40 dark:text-violet-300" disabled={busy} onClick={reload}>{busy ? "Waiting for acknowledgement…" : "Reload exact review"}</button>
  </section>;
}
