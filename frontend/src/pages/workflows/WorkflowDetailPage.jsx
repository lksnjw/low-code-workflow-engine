import WorkflowActions from "../../components/workflows/WorkflowActions";
import Card from "../../components/shared/ui/Card";
import WorkflowBadge from "../../components/workflows/WorkflowBadge";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useRoute } from "../../context/RouteContext";
import { useWorkflow } from "../../hooks/useWorkflows";
import usePermissions from "../../hooks/usePermissions";
import WorkflowAssignments from "../../components/workflows/WorkflowAssignments";
import WorkflowBuilderCanvas from "../../components/canvas/WorkflowBuilderCanvas";
import PendingGenerationApprovalCard from "../../components/workflows/PendingGenerationApprovalCard";
import Button from "../../components/shared/ui/Button";
import { Icon } from "@iconify/react";
import WorkflowSchedulePanel from "../../components/workflows/WorkflowSchedulePanel";
import WorkflowResults from "../../components/workflows/WorkflowResults";
import WorkflowRunDialog from "../../components/workflows/WorkflowRunDialog";
import { useWorkflowDetailRun } from "../../hooks/useWorkflowDetailRun";
import RunAdmissionRecoveryPanel from "../../components/executions/RunAdmissionRecoveryPanel";
import { useNavigate } from "react-router-dom";
import { saveWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";
import { useState } from "react";

/*******************************************************************************
 * Function: WorkflowDetailPage
 *
 * Performs the Workflow Detail Page operation on detail page for the WorkflowDetailPage module.
 ******************************************************************************/
function WorkflowDetailPage() {
  const { selectedWorkflowId, navigateTo } = useRoute();
  const navigate = useNavigate();
  const { has, actorId } = usePermissions();
  const canWrite = has("workflow:write");
  const canEditInChat = canWrite && has("chat:use");
  const canRun = has("workflow:run") || has("workflow:run_own");
  const { data: workflow, isLoading, error, refetch } = useWorkflow(selectedWorkflowId);
  const hasPendingGenerationApproval = Boolean(workflow?.pendingGenerationApproval?.steps?.length);

  const { state: runState, run: handleRun, dismiss: dismissRun, recovery } = useWorkflowDetailRun(workflow?.id, refetch, actorId);
  const [inputWorkflowId, setInputWorkflowId] = useState(null);
  const runDisabled = runState.loading || Boolean(runState.result) || runState.unconfirmed || hasPendingGenerationApproval;

  const submitRun = async input => {
    if (!canRun || runDisabled || inputWorkflowId !== workflow?.id) return;
    return handleRun(input);
  };
  const openRunHelp = text => {
    setInputWorkflowId(null);
    navigate(`/chat?workflow=${encodeURIComponent(workflow.id)}`, { state: { workflowRunHelp: { id: crypto.randomUUID(), workflowId: workflow.id, text } } });
  };

  if (!selectedWorkflowId) return <EmptyState title="No workflow selected" description="Choose a workflow from the workflow list." />;
  if (isLoading) return <LoadingState label="Loading workflow…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!workflow) return <EmptyState title="Workflow not found" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <button type="button" onClick={() => navigateTo("workflows", "list")} className="mb-3 text-sm font-semibold text-primary">← All workflows</button>
          <h1 className="page-heading text-gray-950 dark:text-white">{workflow.name}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">{workflow.description}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {canRun ? (
            <Button
              variant="primary"
              onClick={() => setInputWorkflowId(workflow.id)}
              disabled={runDisabled}
              title={hasPendingGenerationApproval ? "Resolve the pending approval below before running" : undefined}
            >
              {runState.loading ? (
                <span className="flex items-center gap-2">
                  <Icon icon="mdi:loading" className="h-4 w-4 animate-spin" />
                  Running…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Icon icon="mdi:play" className="h-4 w-4" />
                  Run Workflow
                </span>
              )}
            </Button>
          ) : null}
          {canEditInChat ? <Button variant="secondary" onClick={() => {
            // Resolve the current server revision in the chat workspace. Never
            // copy cached YAML into a second draft or publish/run on navigation.
            saveWorkflowForChatEdit({ workflowId: workflow.id, workflowName: workflow.name });
              navigate(`/chat?new=1&creation=${crypto.randomUUID()}&workflow=${encodeURIComponent(workflow.id)}`);
          }}>Edit in chat</Button> : null}
          {canWrite ? <Button variant="secondary" onClick={() => navigateTo("workflows", "builder")}>Preview canvas</Button> : null}
          <WorkflowActions workflow={workflow} onChanged={refetch} showRun={false} />
        </div>
      </div>

      <WorkflowRunDialog key={`inputs:${actorId}:${workflow.id}`} open={canRun && inputWorkflowId === workflow.id} workflowId={workflow.id} onClose={() => setInputWorkflowId(null)} onRun={submitRun} disabled={runDisabled} error={runState.error} onHelp={has("chat:use") ? openRunHelp : undefined} onReview={canEditInChat ? () => { setInputWorkflowId(null); navigate(`/chat?workflow=${encodeURIComponent(workflow.id)}`); } : undefined} />

      {hasPendingGenerationApproval && (
        <PendingGenerationApprovalCard
          pending={{ workflowId: workflow.id, steps: workflow.pendingGenerationApproval.steps }}
          onResolved={refetch}
        />
      )}

      {/* Run result banner */}
      <RunAdmissionRecoveryPanel recovery={recovery} execution={runState.result} allowRelease={false} />
      <WorkflowResults key={`results:${actorId}:${workflow.id}`} workflowId={workflow.id} execution={runState.result} loading={runState.loading || recovery.checking} onDismiss={dismissRun} />
      {runState.error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <Icon icon="mdi:alert-circle" className="h-5 w-5 shrink-0" />
          {runState.error}
          {runState.unconfirmed && <a href="/executions" className="ml-auto font-semibold underline">Review Execution History</a>}
        </div>
      )}

      <Card>
        <div className="grid gap-4 md:grid-cols-4">
          <div><p className="text-xs font-bold uppercase text-gray-500">Owner</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.owner}</p></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Status</p><div className="mt-2"><WorkflowBadge status={workflow.status} /></div></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Steps</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.steps}</p></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Last Run</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.lastRun || "—"}</p></div>
        </div>
      </Card>

      {/* Schedule section — keyed by workflow id so its local edit state resets to
          the freshly-loaded trigger whenever the user switches or reloads a workflow. */}
      {canWrite ? <section id="schedule" className="scroll-mt-6"><WorkflowSchedulePanel key={workflow.id} workflow={workflow} actorId={actorId} /></section> : null}

      {canWrite ? <WorkflowAssignments workflow={workflow} onChanged={refetch} /> : null}
      {!canWrite ? (
        <section>
          <div className="mb-3"><h2 className="section-title">Workflow preview</h2><p className="mt-1 text-sm text-gray-500">This canvas is read-only for your role.</p></div>
          <WorkflowBuilderCanvas workflowId={workflow.id} readOnly embedded />
        </section>
      ) : null}
    </div>
  );
}

export default WorkflowDetailPage;
