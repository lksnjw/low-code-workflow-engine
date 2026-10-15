import { Icon } from "@iconify/react";
import { ReadableResult } from "./ReadableValue";
import { isActiveChatOperation } from "../../hooks/useChatOperationMonitor";

const stages = {
  QUEUED: "Request received",
  PREPARING: "Checking your request and permissions",
  MODEL: "Understanding what you need",
  GENERATING: "Building a workflow draft",
  DRAFT_SAVED: "Saving the workflow draft",
  VERIFYING: "Checking the ERP request",
  GENERATING_NODE_PROPOSAL: "Preparing the selected step change",
  GENERATING_WORKFLOW_PROPOSAL: "Preparing the workflow change",
  PROPOSAL_SAVED: "Saving the proposed change for review",
  READING: "Waiting for the approved ERP tool",
  READ_SAVED: "ERP result received",
  READ_STOPPED: "ERP request stopped",
  ANSWERED: "Answer ready",
  FAILED: "Request stopped safely",
  CANCELLED: "Request cancelled",
  RECOVERY_REQUIRED: "Review required before continuing",
};

const attempts = {
  PREPARING: "Preparing",
  DISPATCH_INTENT: "Sent · waiting for confirmation",
  DONE: "Confirmed result saved",
  FAILED: "Failed",
  UNKNOWN: "Outcome unconfirmed · do not replay",
};

const progressSteps = ["Request", "Checks", "Work", "Answer"];
const progressIndex = {
  QUEUED: 0,
  PREPARING: 1,
  MODEL: 1,
  GENERATING: 2,
  DRAFT_SAVED: 2,
  VERIFYING: 2,
  GENERATING_NODE_PROPOSAL: 2,
  GENERATING_WORKFLOW_PROPOSAL: 2,
  PROPOSAL_SAVED: 2,
  READING: 2,
  READ_SAVED: 2,
  READ_STOPPED: 2,
  ANSWERED: 3,
};

const toolLabel = name => name.replace(/[_-]+/g, " ");
const policyStops = {
  POLICY_REVIEW_REQUIRED: "This ERP read requires policy review.",
  POLICY_DENIED: "Policy denied this ERP read.",
  POLICY_UNAVAILABLE: "The policy check was unavailable.",
  LOCAL_POLICY_CONFIG_INVALID: "The policy check failed.",
  LOCAL_POLICY_PROVIDER_FAILED: "The policy check failed.",
  LOCAL_POLICY_RESPONSE_INVALID: "The policy check failed.",
};

function headlineFor(operation, reconnecting) {
  if (reconnecting) return "Reconnecting…";
  if (!operation) return "Progress is unavailable";
  if (isActiveChatOperation(operation.status)) return "Working on your request";
  if (operation.status === "ANSWERED") return "Request finished";
  if (operation.status === "RECOVERY_REQUIRED") return "Your review is needed";
  if (operation.status === "FAILED") return "Request stopped";
  if (operation.status === "CANCELLED") return "Request cancelled";
  return "Request progress";
}

function ProgressRail({ stage, active }) {
  const current = progressIndex[stage];
  if (current === undefined) return null;
  return <ol aria-label="Request progress" className="mt-3 grid grid-cols-4 gap-1">
    {progressSteps.map((label, index) => {
      const complete = index < current || stage === "ANSWERED";
      const currentStep = index === current && stage !== "ANSWERED";
      return <li key={label} className="min-w-0">
        <div className={`h-1 rounded-full ${complete || currentStep ? "bg-primary" : "bg-gray-200 dark:bg-gray-700"}`} />
        <span className={`mt-1 block truncate text-[10px] ${currentStep && active ? "font-semibold text-primary" : "text-gray-500 dark:text-gray-400"}`}>{label}</span>
      </li>;
    })}
  </ol>;
}

export default function ChatOperationProgress({ operation, answerIntent, events = [], error, reconnecting, onCancel, cancelling, onRefresh }) {
  if (!operation && !error) return null;
  const active = operation && isActiveChatOperation(operation.status);
  const policyStop = operation?.status === "FAILED" && Object.hasOwn(policyStops, operation.reason) ? policyStops[operation.reason] : null;
  const stageLabel = stages[operation?.stage] || "Checking saved progress";
  const headline = headlineFor(operation, reconnecting);
  const icon = operation?.status === "FAILED" || operation?.status === "RECOVERY_REQUIRED"
    ? "lucide:triangle-alert"
    : operation?.status === "ANSWERED"
      ? "lucide:circle-check"
      : "hugeicons:ai-magic";

  return <section aria-label="Saved chat progress" className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3.5 text-xs leading-5 text-gray-600 dark:border-primary/25 dark:bg-primary/[0.06] dark:text-gray-300">
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon icon={icon} className={`h-4 w-4 ${active ? "animate-pulse" : ""}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-gray-950 dark:text-white">{headline}</p>
            <p role="status" aria-live="polite" className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-300">{reconnecting ? "Showing the last saved step while the connection returns" : stageLabel}</p>
          </div>
          {active && <button type="button" aria-label={operation.cancellationRequested ? "Cancel requested" : cancelling ? "Requesting cancellation…" : "Cancel request"} disabled={cancelling || operation.cancellationRequested} onClick={onCancel} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50">{operation.cancellationRequested ? "Cancel requested" : cancelling ? "Requesting cancellation…" : "Cancel"}</button>}
        </div>
        {operation && <ProgressRail stage={operation.stage} active={active} />}
      </div>
    </div>

    {active && cancelling && !operation.cancellationRequested && <p className="mt-3">Cancellation is not yet acknowledged. Saved progress continues to update; work may still be running.</p>}
    {operation?.cancellationRequested && <p className="mt-3">Cancellation does not prove that remote work was rolled back.</p>}
    {operation?.status === "RECOVERY_REQUIRED" && <p className="mt-3">Processing stopped with an uncertain or interrupted outcome. Review saved evidence before starting a new request; nothing will be replayed automatically.</p>}
    {operation?.status === "FAILED" && <p className="mt-3">{policyStop ? `${policyStop} This attempted read was not dispatched. Nothing will be retried automatically.` : operation.reason === "DRAFT_REVISION_CONFLICT" ? "The workflow draft changed while this proposal was being prepared. No proposal was saved. Reload and review the current node before submitting a new edit." : operation.reason === "NODE_PROPOSAL_INVALID" ? "A supported node patch could not be prepared. No proposal was saved and the workflow was not changed. Review the prompt and model configuration before a new request." : "The request stopped before a response could be saved. Check connection and permissions before submitting a new request."}</p>}
    {operation?.status === "ANSWERED" && <p className="mt-3">{answerIntent === "CONVERSATION" ? "Reply saved." : answerIntent === "WORKFLOW_DISCUSSION" ? "Explanation saved. No workflow changes were applied." : "A saved response is not proof of email delivery, workflow execution or scheduling."}</p>}
    {operation?.artifactRefs?.map(reference => <p key={reference.id} className="mt-3">{reference.type === "workflow-proposal" ? `Workflow change proposed · ${reference.id}. Review and apply it to save a new draft; nothing was published or run.` : reference.type === "node-proposal" ? `Node proposal saved · ${reference.id}. Its current review status is shown beside the workflow.` : `Workflow draft saved · ${reference.id}. This preparation step did not publish or execute it. Check its current status in Workflows.`}</p>)}

    {operation?.attempts?.length > 0 && <details className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
      <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-200">ERP tool results · {operation.attempts.length}</summary>
      <div className="mt-2 space-y-2">{operation.attempts.map(attempt => <details key={attempt.id} open={attempt.status === "DONE"} className="rounded-lg bg-white/70 px-3 py-2 dark:bg-gray-900/50">
        <summary className="cursor-pointer"><span className="font-medium">{toolLabel(attempt.toolName)}</span> · {attempts[attempt.status] || "Unknown status"}</summary>
        <div className="mt-2">{["DONE", "FAILED"].includes(attempt.status) && attempt.output !== undefined ? <ReadableResult value={attempt.output} /> : <p>{attempt.status === "UNKNOWN" ? "No confirmed answer is available. An automatic retry could duplicate remote work." : "No confirmed result has been saved for this attempt."}</p>}</div>
      </details>)}</div>
    </details>}

    {(operation || events.length > 0) && <details className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
      <summary className="cursor-pointer text-gray-500">Technical details</summary>
      {operation && <div className="mt-2 space-y-1 text-[11px] text-gray-500">
        <p>Model: {operation.modelBinding?.requestedModel || operation.modelBinding?.model || "No model bound"}</p>
        <p>Progress: {operation.persistence === "durable" ? "Saved on server" : "Memory only · lost on server restart"}</p>
        {operation.nodeContext && <p>Node {operation.nodeContext.nodeId} · source draft v{operation.nodeContext.baseVersion} · proposal only</p>}
      </div>}
      {events.length > 0 && <ol className="mt-2 space-y-1">{events.slice(-20).map(event => <li key={event.sequence}>{stages[event.stage] || "Saved stage"} <time className="text-gray-500" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time></li>)}</ol>}
      {events.length > 20 && <p className="text-gray-500">Showing the latest 20 recorded stages.</p>}
    </details>}

    {error && <p role="alert" className="mt-3 text-red-700 dark:text-red-300">{error}</p>}
    {onRefresh && <button type="button" aria-label="Refresh saved progress" onClick={onRefresh} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-[11px] font-medium hover:border-primary hover:text-primary dark:border-gray-700"><Icon icon="lucide:refresh-cw" className="h-3 w-3" />Refresh progress</button>}
  </section>;
}
