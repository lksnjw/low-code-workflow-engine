import { useState } from "react";
import { executionService } from "../../services/execution.service";

export default function ExecutionRetryAction({ execution, denied, onRetried }) {
  const [reviewing, setReviewing] = useState(false), [confirmed, setConfirmed] = useState(false), [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [created, setCreated] = useState(null);
  const [unconfirmedRequest, setUnconfirmedRequest] = useState(false);
  const admission = execution.retryAdmission;
  if (!admission || !["FAILED", "CANCELLED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(execution.status)) return null;
  if (!admission.allowed) return <p className="text-gray-500">Retry unavailable: {admission.reason}</p>;
  const submit = async () => {
    if (!confirmed || admission.requiresUncertaintyAcknowledgement && !uncertain || busy || denied) return;
    setBusy(true); setError("");
    try {
      const run = await executionService.retry(execution.id, uncertain);
      setCreated(run); onRetried?.(run);
    } catch (cause) { setUnconfirmedRequest(cause?.runAdmissionUnconfirmed === true); setError(cause?.response?.data?.message || cause?.runAdmissionMessage || cause?.message || "Retry admission was not confirmed. Check the same request; do not create another run."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Retry execution" className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
    <h3 className="font-semibold">Retry as a new execution</h3>
    <p>Restarts from the first step using the original inputs. The failed run, saved answers and failure evidence are kept. Current validation and fresh transaction approvals still apply.</p>
    {execution.status === "RECOVERY_REQUIRED" && <p role="alert" className="text-amber-700 dark:text-amber-300">The earlier read or model result is unknown. Another read may run and another model call may incur cost. No ERP write was dispatched; uncertain writes cannot use this retry.</p>}
    {created ? <a className="font-semibold text-primary" href={`/executions/${encodeURIComponent(created.id)}`}>Open new execution {created.id}</a> : !reviewing ?
      <button disabled={denied} onClick={() => setReviewing(true)} className="min-h-9 rounded-md border border-gray-300 px-3 disabled:opacity-50 dark:border-gray-700">Review retry</button> : <div className="space-y-3">
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />I understand this starts a separate run from the first step, not a resume.</label>
        {admission.requiresUncertaintyAcknowledgement && <label className="flex items-start gap-2"><input type="checkbox" checked={uncertain} onChange={event => setUncertain(event.target.checked)} disabled={busy} />I acknowledge the unconfirmed read/model result and possible additional provider cost.</label>}
        <div className="flex flex-wrap gap-2"><button disabled={busy || denied || !confirmed || admission.requiresUncertaintyAcknowledgement && !uncertain} onClick={submit} className="min-h-9 rounded-md bg-primary px-3 text-white disabled:opacity-50">{busy ? "Checking retry…" : unconfirmedRequest ? "Check same retry request" : "Start new execution"}</button><button disabled={busy} onClick={() => setReviewing(false)} className="min-h-9 px-3">Close</button></div>
      </div>}
    {error && <p role="alert" className="text-amber-700 dark:text-amber-300">{error}</p>}
  </section>;
}
