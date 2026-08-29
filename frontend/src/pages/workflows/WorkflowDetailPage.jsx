import { useState } from "react";
import WorkflowActions from "../../components/workflows/WorkflowActions";
import Card from "../../components/shared/ui/Card";
import WorkflowBadge from "../../components/workflows/WorkflowBadge";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useRoute } from "../../context/RouteContext";
import { useWorkflow } from "../../hooks/useWorkflows";
import usePermissions from "../../hooks/usePermissions";
import WorkflowAssignments from "../../components/workflows/WorkflowAssignments";
import WorkflowBuilderCanvas from "../../components/canvas/WorkflowBuilderCanvas";
import Button from "../../components/shared/ui/Button";
import { executionService } from "../../services/execution.service";
import { workflowService } from "../../services/workflow.service";
import { Icon } from "@iconify/react";

function WorkflowDetailPage() {
  const { selectedWorkflowId, navigateTo } = useRoute();
  const { has } = usePermissions();
	const canWrite = has("workflow:write");
  const canRun = has("workflow:run") || canWrite;
  const { data: workflow, isLoading, error, refetch } = useWorkflow(selectedWorkflowId);

  const [runState, setRunState] = useState({ loading: false, result: null, error: null });
  const [scheduleState, setScheduleState] = useState({ saving: false, saved: false });
  const [cronExpr, setCronExpr] = useState("");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);

  if (!selectedWorkflowId) return <EmptyState title="No workflow selected" description="Choose a workflow from the workflow list." />;
  if (isLoading) return <LoadingState label="Loading workflow…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!workflow) return <EmptyState title="Workflow not found" />;

  const handleRun = async () => {
    setRunState({ loading: true, result: null, error: null });
    try {
      const execution = await executionService.run(workflow.id, {});
      setRunState({ loading: false, result: execution, error: null });
      refetch();
    } catch (err) {
      setRunState({ loading: false, result: null, error: err?.response?.data?.message || "Execution failed." });
    }
  };

  const handleSaveSchedule = async () => {
    setScheduleState({ saving: true, saved: false });
    try {
      const trigger = scheduleEnabled && cronExpr.trim()
        ? { type: "schedule", displayName: `Schedule: ${cronExpr}`, config: { cron: cronExpr.trim() } }
        : { type: "manual", displayName: "Manual" };
      await workflowService.update(workflow.id, { trigger });
      setScheduleState({ saving: false, saved: true });
      refetch();
    } catch {
      setScheduleState({ saving: false, saved: false });
    }
  };

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
              onClick={handleRun}
              disabled={runState.loading}
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
          {canWrite ? <Button variant="secondary" onClick={() => navigateTo("workflows", "builder")}>Edit in builder</Button> : null}
          <WorkflowActions workflow={workflow} onChanged={refetch} />
        </div>
      </div>

      {/* Run result banner */}
      {runState.result && (
        <div className={`flex items-start gap-3 rounded-xl border p-4 ${runState.result.status === "DONE" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          <Icon
            icon={runState.result.status === "DONE" ? "mdi:check-circle" : "mdi:alert-circle"}
            className={`mt-0.5 h-5 w-5 shrink-0 ${runState.result.status === "DONE" ? "text-emerald-600" : "text-red-600"}`}
          />
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-bold ${runState.result.status === "DONE" ? "text-emerald-800" : "text-red-800"}`}>
              Execution {runState.result.status === "DONE" ? "completed" : "failed"} · {runState.result.id}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">{runState.result.duration} · {runState.result.tokens} tokens</p>
            {runState.result.finalOutput && (
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-slate-900 p-2 text-[10px] leading-4 text-green-300">
                {JSON.stringify(runState.result.finalOutput, null, 2)}
              </pre>
            )}
          </div>
          <button type="button" onClick={() => setRunState({ loading: false, result: null, error: null })} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
      )}
      {runState.error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <Icon icon="mdi:alert-circle" className="h-5 w-5 shrink-0" />
          {runState.error}
          <button type="button" onClick={() => setRunState({ loading: false, result: null, error: null })} className="ml-auto text-red-400 hover:text-red-600">✕</button>
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

      {/* Schedule section */}
      {canWrite ? (
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <Icon icon="mdi:clock-outline" className="h-5 w-5 text-primary" />
            <h2 className="section-title">Schedule</h2>
          </div>
          <div className="space-y-4">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-primary"
              />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Enable automatic scheduling</span>
            </label>
            {scheduleEnabled && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-600 dark:text-gray-400">
                  Cron expression
                  <span className="ml-2 font-normal text-gray-400">(e.g. <code>0 9 * * 1</code> = every Monday at 9 AM)</span>
                </label>
                <input
                  type="text"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="0 9 * * 1"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-700 dark:bg-darkBackground dark:text-white"
                />
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button variant="secondary" onClick={handleSaveSchedule} disabled={scheduleState.saving}>
                {scheduleState.saving ? "Saving…" : "Save Schedule"}
              </Button>
              {scheduleState.saved && (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <Icon icon="mdi:check-circle" className="h-4 w-4" />
                  Schedule saved
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400">
              Current trigger: <span className="font-semibold">{workflow.trigger}</span>
            </p>
          </div>
        </Card>
      ) : null}

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
