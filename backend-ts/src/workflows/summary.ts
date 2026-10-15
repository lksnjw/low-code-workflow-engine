import type { Workflow } from "../models/schemas.js";
import type { Execution } from "../repository/store.js";

/** Display projection only. Never rewrite a publication or run to update UI counters. */
export function workflowSummary(workflow: Workflow, executions: readonly Execution[], actor?: { id: string; permissions: readonly string[] }) {
  const { yaml: _yaml, archived: _archived, canvas: _canvas, ...visible } = workflow;
  const runs = executions.filter(run => run.workflowId === workflow.id && Number.isFinite(Date.parse(run.startedAt)));
  const latest = runs.reduce<Execution | undefined>((last, run) => !last || Date.parse(run.startedAt) > Date.parse(last.startedAt) ? run : last, undefined);
  const finished = runs.filter(run => ["DONE", "FAILED", "CANCELLED", "REJECTED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(run.status));
  const published = workflow.publishedVersion > 0 && workflow.publishedVersion === workflow.draftVersion && workflow.canRun && !workflow.pendingGenerationApproval?.steps.length;
  const canRun = workflow.canRun && (!actor || actor.permissions.includes("workflow:run") || actor.permissions.includes("workflow:run_own") && (workflow.owner.id === actor.id || (workflow.assignedUserIds ?? []).includes(actor.id)));
  return { ...visible, canRun, status: published ? "PUBLISHED" : workflow.status === "DONE" ? "PENDING" : workflow.status,
    lastRunAt: latest?.startedAt ?? null,
    successRate: finished.length ? 100 * finished.filter(run => run.status === "DONE").length / finished.length : 0 };
}
