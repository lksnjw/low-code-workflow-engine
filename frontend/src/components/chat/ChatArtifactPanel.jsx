import { Icon } from "@iconify/react";
import { useRoute } from "../../context/RouteContext";
import usePermissions from "../../hooks/usePermissions";
import { saveWorkflowForCanvas } from "../../utils/workflowCanvas.utils";
import { workflowArtifactStatus } from "./workflowArtifactStatus";
import ReadableValue from "./ReadableValue";
import { Collapsible, Pill, SectionHeader } from "./ChatArtifactPrimitives";
import { ExampleCard, RuleCard, ToolCard } from "./ChatArtifactRetrieval";
import { NextActionBanner } from "./ChatArtifactStatus";
import QueryResultPanel from "./ChatQueryResultPanel";
import ProtectedPatchPreview from "./ProtectedPatchPreview";

/*******************************************************************************
 * Function: ChatArtifactPanel
 *
 * Performs the Chat Artifact Panel operation on artifact panel for the ChatArtifactPanel module.
 ******************************************************************************/
function ChatArtifactPanel({ artifact }) {
  const { startWorkflow } = useRoute();
  const { has } = usePermissions();
	const canEditWorkflow = has("workflow:write");

  if (!artifact) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-darkBackground">
        <Icon icon="tabler:git-branch" className="h-10 w-10 text-gray-300 dark:text-gray-600" />
        <p className="text-sm font-semibold text-gray-400 dark:text-gray-500">No artifact yet</p>
        <p className="max-w-[200px] text-xs text-gray-400 dark:text-gray-600">
          Send a request to generate and validate a workflow.
        </p>
      </div>
    );
  }

  // Query / Audit path (intent-routed)
  if (artifact.intent === "QUERY" || artifact.intent === "AUDIT") {
    return <QueryResultPanel artifact={artifact} />;
  }

  if (artifact.intent === "WORKFLOW_PATCH_PROPOSAL") {
    return <section className="space-y-2 text-xs"><h3 className="font-semibold">Workflow change proposal</h3><p>{artifact.proposal?.summary}</p><p>{artifact.proposal?.status ?? "Unknown status"}</p><p className="text-gray-500">Review and apply this change in the saved workflow's canvas controls. Nothing is published or run by this proposal.</p></section>;
  }
  if (artifact.intent === "WORKFLOW_CONTROL") {
    return <p className="text-xs text-gray-500">Review the saved workflow controls in chat. No workflow command has been executed by this message.</p>;
  }
  if (artifact.intent === "NODE_PATCH_PROPOSAL") {
    return <section className="space-y-2 text-xs"><h3 className="font-semibold">Node proposal · {artifact.proposal?.nodeId}</h3><p>{artifact.proposal?.status ?? "Unknown status"}</p><p className="text-gray-500">Review this change in the workflow workspace. Applying saves a draft; it does not publish or execute.</p>{artifact.proposal?.command?.type === "updateProtected" && artifact.proposal.command.patch?.output && !artifact.proposal.command.patch.onError ? <ProtectedPatchPreview proposal={artifact.proposal} /> : <ReadableValue value={artifact.proposal?.after} />}</section>;
  }

  const {
    blocking_errors: rawBlockingErrors,
    can_execute,
    candidates: rawCandidates,
    next_action,
    retrieval = {},
    validation_summary = {},
    selected_workflow_yaml,
    selected_candidate_id,
    chatSessionId,
    chatMessageId,
    traceId,
    workflowId,
  } = artifact;

  const blocking_errors = rawBlockingErrors ?? [];
  const candidates = rawCandidates ?? [];
  const status = workflowArtifactStatus(artifact);

  const tools = retrieval.tools ?? [];
  const rules = [...(retrieval.rules ?? []), ...(retrieval.global_rules ?? [])];
  const examples = retrieval.examples ?? [];

/*******************************************************************************
 * Function: handlePassToCanvas
 *
 * Handles pass to canvas for the ChatArtifactPanel module.
 ******************************************************************************/
  const handlePassToCanvas = () => {
    if (!selected_workflow_yaml) return;

    saveWorkflowForCanvas({
      yaml: selected_workflow_yaml,
      candidateId: selected_candidate_id,
      canExecute: can_execute,
      validationSummary: validation_summary,
      source: "chat_semantic_validator",
      chatSessionId,
      chatMessageId,
      traceId,
      // The chat handler already auto-saved this workflow (workflowId). Passing it
      // through lets the canvas update that same record on deploy instead of
      // creating a second, duplicate workflow.
      workflowId,
    });
    startWorkflow();
  };

  return (
    <div className="space-y-3">
      {/* ── Validation summary ── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
        <SectionHeader icon="mdi:shield-check-outline" label="Validation" />
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Passed", value: validation_summary.passed_candidates ?? 0, color: "text-emerald-600 dark:text-emerald-400" },
            { label: "Blocked", value: validation_summary.blocked_candidates ?? 0, color: "text-red-500 dark:text-red-400" },
            { label: "Best Score", value: validation_summary.best_score != null ? (validation_summary.best_score * 100).toFixed(0) + "%" : "—", color: "text-primary" },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-xl bg-gray-50 p-2 text-center dark:bg-darkBackgroundVery">
              <p className={`text-lg font-black ${color}`}>{value}</p>
              <p className="text-[10px] text-gray-400">{label}</p>
            </div>
          ))}
        </div>

        {/* can_execute badge */}
        <div className="mt-3 flex items-center gap-2">
          <Icon
            icon={status.passed === true ? "mdi:check-circle" : "mdi:shield-alert"}
            className={`h-4 w-4 ${status.passed === true ? "text-emerald-500" : "text-amber-500"}`}
          />
          <span className={`text-xs font-semibold ${status.passed === true ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
            {status.draft} · {status.label}
          </span>
        </div>
        <p className="mt-2 text-[10px] text-gray-500">{status.lifecycle}</p>
        {canEditWorkflow && selected_workflow_yaml && (
          <button
            type="button"
            onClick={handlePassToCanvas}
            className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-slate-950 px-3 text-xs font-bold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
          >
            <Icon icon="mdi:graph-outline" className="h-4 w-4" />
            Pass to Canvas
          </button>
        )}
      </div>

      {/* ── Next action ── */}
      {next_action && <NextActionBanner nextAction={next_action} />}

      {/* ── Blocking errors ── */}
      {blocking_errors.length > 0 && (
        <Collapsible
          title="Blocking Errors"
          icon="mdi:alert-circle-outline"
          count={blocking_errors.length}
          defaultOpen
        >
          <div className="space-y-2">
            {blocking_errors.map((err, i) => (
              <div key={i} className="flex gap-2 rounded-lg bg-red-50 p-2 text-xs dark:bg-red-900/20">
                <Icon icon="mdi:close-circle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                <p className="text-red-700 dark:text-red-300">{err}</p>
              </div>
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Retrieved Tools ── */}
      {tools.length > 0 && (
        <Collapsible title="Retrieved Tools" icon="mdi:tools" count={tools.length} defaultOpen>
          <div className="space-y-2">
            {tools.map((tool, i) => (
              <ToolCard key={tool.tool_id || tool.name || i} tool={tool} />
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Governance Rules ── */}
      {rules.length > 0 && (
        <Collapsible title="Governance Rules" icon="mdi:scale-balance" count={rules.length}>
          <div className="space-y-2">
            {rules.map((rule, i) => (
              <RuleCard key={rule.rule_id || rule.rule_name || i} rule={rule} />
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Similar Examples ── */}
      {examples.length > 0 && (
        <Collapsible title="Similar Scenarios" icon="mdi:lightbulb-outline" count={examples.length}>
          <div className="space-y-2">
            {examples.map((ex, i) => (
              <ExampleCard key={ex.scenario_id || i} example={ex} />
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Candidates (if any) ── */}
      {candidates.length > 0 && (
        <Collapsible title="Candidates" icon="mdi:format-list-bulleted-square" count={candidates.length}>
          <div className="space-y-2 text-xs">
            {candidates.map((c, i) => (
              <div key={c.id ?? i} className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 dark:border-gray-800 dark:bg-darkBackgroundVery">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-gray-800 dark:text-white">{c.id ?? `Candidate ${i + 1}`}</span>
                  <Pill color={c.status === "PASS" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"}>
                    {c.status ?? "—"}
                  </Pill>
                </div>
                {c.score != null && <p className="mt-1 text-gray-400">Score: {(c.score * 100).toFixed(1)}%</p>}
              </div>
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── YAML preview ── */}
      {selected_workflow_yaml && (
        <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
          <SectionHeader icon="mdi:code-braces" label="Generated YAML" />
          <pre className="max-h-64 overflow-auto rounded-xl bg-gray-900 p-3 text-[10px] leading-5 text-green-300">
            {selected_workflow_yaml}
          </pre>
        </div>
      )}
    </div>
  );
}

export { NextActionBanner, QueryResultPanel };
export default ChatArtifactPanel;
