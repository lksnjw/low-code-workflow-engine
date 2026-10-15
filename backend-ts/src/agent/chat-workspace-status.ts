import type { RepositoryState } from "../repository/store.js";
import type { CurrentUser } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { canReadExecution } from "../http/execution-scope.js";
import { permittedWorkflow } from "../workflows/commands.js";
import { executionRetryView } from "../runner/execution-retry.js";

export type ChatWorkspaceStatus = {
  profile: "chat-workspace-status/v1";
  sampledAt: string;
  workflows: Array<{ id: string; draftVersion: number; publishedVersion: number;
    latestRun: { id: string; status: string; publishedVersion: number | null;
      failure?: { category: string; nodeId: string | null };
      retryReview?: ReturnType<typeof executionRetryView> } | null }>;
};
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const runStatuses = new Set(["PENDING", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED", "UNKNOWN", "CANCELLED", "REJECTED", "EXPIRED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED", "BLOCKED"]);
const time = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

/** Bounded saved facts, not a tool capability or an execution permit. Never
 * project YAML, descriptions, inputs, outputs, approvals or private journals. */
export function chatWorkspaceStatus(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string): ChatWorkspaceStatus {
  assertChatAuthority(state, user, sessionId);
  const workflows = Object.values(state.workflows)
    .filter(workflow => workflow.chatSessionId === sessionId && permittedWorkflow(workflow, user, false) &&
      safeId(workflow.id) && version(workflow.draftVersion) && version(workflow.publishedVersion))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 5)
    .map(workflow => {
      const latest = Object.values(state.executions)
        .filter(run => run.workflowId === workflow.id && safeId(run.id) && canReadExecution(user, run))
        .sort((a, b) => time(b.startedAt) - time(a.startedAt) || a.id.localeCompare(b.id))[0];
      return { id: workflow.id, draftVersion: workflow.draftVersion, publishedVersion: workflow.publishedVersion,
        latestRun: latest ? { id: latest.id, status: runStatuses.has(latest.status) ? latest.status : "UNKNOWN",
          publishedVersion: version(latest.workflowSnapshot?.version) ? latest.workflowSnapshot!.version : null,
          ...(latest.failure ? { failure: { category: typeof latest.failure.failureCategory === "string" && /^[A-Z_]{1,64}$/.test(latest.failure.failureCategory) ? latest.failure.failureCategory : "RECORDED_FAILURE",
            nodeId: typeof latest.failure.failedStepId === "string" && safeId(latest.failure.failedStepId) ? latest.failure.failedStepId : null } } : {}),
          ...(latest.readProgress?.profile === "read-progress-v1" && ["FAILED", "CANCELLED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(latest.status) ? { retryReview: executionRetryView(state, user, latest) } : {}) } : null };
    });
  return { profile: "chat-workspace-status/v1", sampledAt: new Date().toISOString(), workflows };
}

/** Re-sample inside the answer commit: a model wait must not freeze the
 * visible workflow state. Preserve the model text as interpretation and add
 * a separately labelled server-owned snapshot; never infer delivery from DONE. */
export function workspaceStatusAnswer(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string,
  text: string, artifacts: Record<string, unknown>) {
  const workspaceStatus = chatWorkspaceStatus(state, user, sessionId);
  if (!workspaceStatus.workflows.length) return { text, artifacts };
  const rows = workspaceStatus.workflows.map(workflow => {
    const publication = workflow.publishedVersion > 0 ? `published v${workflow.publishedVersion}` : "not published";
    const run = workflow.latestRun ? `latest recorded run ${workflow.latestRun.id}: ${workflow.latestRun.status}` +
      (workflow.latestRun.publishedVersion === null ? " (version not recorded)" : ` (published v${workflow.latestRun.publishedVersion})`) : "no recorded run";
    const failure = workflow.latestRun?.failure ? ` Saved failure: ${workflow.latestRun.failure.category}${workflow.latestRun.failure.nodeId ? ` at ${workflow.latestRun.failure.nodeId}` : ""}.` : "";
    const retry = workflow.latestRun?.retryReview ? workflow.latestRun.retryReview.allowed ? " Retry may be reviewed below; explicit confirmation and fresh system validation are required. Nothing was restarted by this answer." : " Whole-workflow retry is not currently allowed; review the saved execution evidence." : "";
    return `- Workflow ${workflow.id}: draft v${workflow.draftVersion}; ${publication}; ${run}.${failure}${retry}`;
  });
  return { text: `${text}\n\n**Saved workflow state — server record**\n\n${rows.join("\n")}\n\nSnapshot at ${workspaceStatus.sampledAt}. This saved state takes precedence over historical chat or model descriptions. A completed run alone is not proof of email delivery.`,
    artifacts: { ...artifacts, workspaceStatus } };
}
