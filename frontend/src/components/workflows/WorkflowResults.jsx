import { useEffect, useRef, useState } from "react";
import { executionService } from "../../services/execution.service";
import { currentAuthorityEpoch } from "../../utils/authAuthority";
import WorkflowRunReceipt from "./WorkflowRunReceipt";

/** Explicit history reads never admit or retry a workflow. */
export default function WorkflowResults({ workflowId, execution, monitor, loading = false, onDismiss }) {
  const [saved, setSaved] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), active = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  const scope = `${currentAuthorityEpoch()}:${workflowId}`;
  const mismatch = Boolean(execution?.workflowId && execution.workflowId !== workflowId);
  const result = monitor?.denied || mismatch ? null : execution || (saved?.scope === scope ? saved.execution : null);
  const latest = async () => {
    if (active.current) return; active.current = true; setBusy(true); setError("");
    const epoch = currentAuthorityEpoch(), version = ++generation.current;
    const current = () => generation.current === version && currentAuthorityEpoch() === epoch;
    try {
      const rows = await executionService.list({ workflowId, limit: 1 });
      if (!current()) return;
      const row = rows[0];
      if (!row) { setSaved(null); setError("No saved run was found for this workflow."); return; }
      const value = await executionService.get(row.id);
      if (!current()) return;
      if (value.workflowId !== workflowId || value.id !== row.id) throw new Error("The result does not match this workflow.");
      setSaved({ scope, execution: value });
    } catch (cause) { if (current()) { setSaved(null); setError(cause?.response?.data?.message || cause?.message || "Could not load saved results. No new run was sent."); } }
    finally { active.current = false; if (current()) setBusy(false); }
  };
  return <section aria-label="Workflow results" className="space-y-3 border-y border-gray-200 py-4 dark:border-gray-700">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Workflow results</h2><button type="button" disabled={busy || loading || Boolean(execution) || monitor?.denied} onClick={latest} className="text-xs font-semibold text-primary disabled:opacity-50">{busy ? "Loading saved results…" : "Load latest saved result"}</button></div>
    {(monitor?.denied || mismatch) && <p role="alert" className="text-sm text-amber-700">{mismatch ? "This result belongs to another workflow and is hidden." : "This run is no longer available to this account. Saved answers are hidden."}</p>}
    {loading && !result && <p role="status" className="text-sm text-gray-500">Checking the original run. Results will appear here when its receipt is available; no second run is being sent.</p>}
    {!result && !loading && !monitor?.denied && !mismatch && <p className="text-sm text-gray-500">No run selected. Start a workflow or load a saved result to see its status, output and completed steps here.</p>}
    {error && <p role="alert" className="text-xs text-amber-700">{error}</p>}
    {result && !execution && <p className="text-xs text-gray-500">Saved historical result. Viewing it does not resolve a different unconfirmed run or start another workflow.</p>}
    {result && <WorkflowRunReceipt key={result.id} initialExecution={result} externalMonitor={execution ? monitor : undefined} onDismiss={execution ? onDismiss : undefined} />}
  </section>;
}
