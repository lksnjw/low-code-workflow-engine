import { useNavigate } from "react-router-dom";
import { useChatWorkspace } from "./ChatWorkspaceContext";
import { parseWorkflowPreview, workflowSource } from "./workflowPreview";
import WorkflowFixButton from "./WorkflowFixButton";

/** Historical draft guidance is not a current approval or execution receipt. */
export default function WorkflowDraftHelp({ artifact, busy = false }) {
  const workspace = useChatWorkspace(), navigate = useNavigate();
  const draft = parseWorkflowPreview(workflowSource(artifact));
  const requirements = Array.isArray(draft.metadata?.unresolved_requirements) ? draft.metadata.unresolved_requirements.filter(value => typeof value === "string") : [];
  const failed = artifact.validation?.passed === false || artifact.validation_passed === false;
  if (!failed && (draft.error || draft.steps.length > 0 && requirements.length === 0)) return null;
  const workflowId = artifact.workflowId;
  if (typeof workflowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) return null;
  const open = () => workspace?.openWorkflow ? workspace.openWorkflow(workflowId) : navigate(`/workflows/${encodeURIComponent(workflowId)}`);
  return <section aria-label="Complete workflow draft" className="mt-3 space-y-2 border-l-2 border-amber-400 pl-3 text-xs">
    <h3 className="font-semibold">This draft needs more information</h3>
    <p className="leading-5 text-gray-600 dark:text-gray-300">{draft.steps.length === 0 ? "There is no approval to confirm on this draft. Complete its required details and steps first; an OK button cannot make it runnable." : "Resolve the required details and validation issues before publishing or running. Approving a transaction does not replace validation."}</p>
    {requirements.length > 0 && <details><summary className="cursor-pointer font-medium text-primary">Missing requirements · {requirements.length}</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-gray-500">{requirements.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
    <p className="leading-5 text-gray-500">Continue in chat with “Help me finish this workflow,” then answer the assistant’s questions. Required ERP access must also be available.</p>
    <div className="flex flex-wrap gap-2 pt-1">
      <WorkflowFixButton workflowId={workflowId} requirements={requirements} errors={artifact.validation?.errors} busy={busy} />
      {workspace?.openWorkflow && workspace.focusChat && <button type="button" disabled={busy} onClick={() => { open(); workspace.focusChat(); }} className="rounded-lg bg-primary px-3 py-2 font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50">Complete in chat</button>}
      <button type="button" disabled={busy} onClick={() => { open(); workspace?.openCanvasTools?.(); }} className="rounded-lg border border-primary/30 px-3 py-2 font-semibold text-primary transition-colors hover:bg-primary/5 disabled:opacity-50">Review draft requirements</button>
    </div>
    <p className="text-[11px] text-gray-500">This is the saved proposal’s status. Open the current draft to check its latest readiness. No action is run by these buttons.</p>
  </section>;
}
