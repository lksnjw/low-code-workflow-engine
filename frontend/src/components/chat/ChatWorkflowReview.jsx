import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChatWorkspace } from "./ChatWorkspaceContext";
import ReadableValue from "./ReadableValue";

const WorkflowSchedulePanel = lazy(() => import("../workflows/WorkflowSchedulePanel"));
const button = "rounded-lg border border-primary/30 px-3 py-2 text-xs font-semibold text-primary disabled:opacity-50";

/** Chat controls select an existing saved workflow. Applying, publishing and
 * running stay in the revision-checked editor, never a duplicate canvas import. */
export default function ChatWorkflowReview({ proposal, control, busy = false }) {
  const workspace = useChatWorkspace(), navigate = useNavigate();
  const [showSchedule, setShowSchedule] = useState(false);
  const workflowId = proposal?.workflowId ?? control?.workflowId;
  if (typeof workflowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) return null;
  const pending = proposal?.status === "PROPOSED";
  const open = () => {
    if (workspace?.openWorkflow) { workspace.openWorkflow(workflowId); workspace.openCanvasTools?.(); }
    else navigate(`/workflows/${encodeURIComponent(workflowId)}`);
  };
  return <section aria-label={proposal ? "Workflow change review" : "Saved workflow controls"} className="mt-4 space-y-3 rounded-xl border border-primary/25 p-4 text-sm">
    <h3 className="font-semibold">{proposal ? "Review workflow change" : control.name}</h3>
    {proposal ? <>
      <p role="status" className="text-xs text-gray-500">{proposal.status === "APPLIED" ? `Saved to draft v${proposal.appliedVersion} · not published or run` : proposal.status === "DISCARDED" ? "Discarded · saved workflow unchanged" : "Proposed · saved draft unchanged"}</p>
      <p>{proposal.summary}</p>
      <details className="text-xs"><summary className="cursor-pointer text-primary">Compare requested change</summary><p className="mt-3 font-semibold">Before</p><ReadableValue value={proposal.before} /><p className="mt-3 font-semibold">After</p><ReadableValue value={proposal.after} /></details>
      {pending && <p className="text-xs text-gray-500">Review the change in the canvas controls, then Apply to draft or Discard. Applying does not publish, run or schedule it.</p>}
      {pending && proposal.validation?.passed === false && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">This proposal has validation issues. Review them before saving a blocked draft.</p>}
    </> : <p role="status" className="text-xs text-gray-500">{control.scheduleCommandApplied ? `Schedule ${control.scheduleState === "ACTIVE" ? "active" : "paused"} · saved revision ${control.scheduleRevision}${control.nextRunAt ? ` · next run ${control.nextRunAt}` : ""}` : `Requested ${control.action} · no command executed by this message`}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={busy} onClick={open}>{pending ? "Review and apply in canvas" : control?.action === "run" ? "Review run in canvas" : control?.action === "publish" ? "Review publication in canvas" : "Open saved workflow"}</button>
      {control?.canEdit && ["schedule", "pause"].includes(control.action) && <button type="button" className={button} disabled={busy} aria-expanded={showSchedule} onClick={() => setShowSchedule(value => !value)}>{showSchedule ? "Hide schedule controls" : "Review schedule here"}</button>}
    </div>
    {showSchedule && <Suspense fallback={<p role="status" className="text-xs text-gray-500">Loading current schedule controls…</p>}><WorkflowSchedulePanel key={workflowId} workflow={{ id: workflowId }} actorId={control.actorId} suggestion={control.scheduleSuggestion} /></Suspense>}
  </section>;
}
