import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@iconify/react";
import ProtectedPatchPreview from "./ProtectedPatchPreview";
import MessageMarkdown from "./MessageMarkdown";
import { saveWorkflowForCanvas } from "../../utils/workflowCanvas.utils";
import PendingGenerationApprovalCard from "../workflows/PendingGenerationApprovalCard";
import { workflowArtifactStatus } from "./workflowArtifactStatus";
import { ReadableResult } from "./ReadableValue";
import EmailDraftPreview from "./EmailDraftPreview";
import { InlineSources, InlineVisualisation } from "./ChatMessageVisualisation";
import ChatRequestRevision from "./ChatRequestRevision";
import ChatRunRecovery from "./ChatRunRecovery";
import ToolProposalChecks from "./ToolProposalChecks";
import ChatErpActionCard from "./ChatErpActionCard";
import EmailPreparationHelp from "./EmailPreparationHelp";
import ChatWorkflowReview from "./ChatWorkflowReview";
import WorkflowDraftHelp from "./WorkflowDraftHelp";
import ChatAttachmentReview from "./ChatAttachmentReview";
import { useChatWorkspace } from "./ChatWorkspaceContext";

// ── Inline validation badge ─────────────────────────────────────────────────
/*******************************************************************************
 * Function: ValidationBadge
 *
 * Performs the Validation Badge operation on badge for the ChatMessage module.
 ******************************************************************************/
function ValidationBadge({ artifact, failedRules = [] }) {
  const status = workflowArtifactStatus(artifact);
  return (
    <div className={`mt-2 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
      status.passed === true
        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300"
        : "border-red-200 bg-red-50 text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-300"
    }`}>
      <Icon icon={status.passed === true ? "mdi:shield-check" : "mdi:shield-alert"} className="h-3.5 w-3.5 shrink-0" />
      <span className="font-semibold">{status.draft} · {status.label}</span>
      <span>{status.lifecycle}</span>
      {status.passed !== true && failedRules.length > 0 && (
        <span className="font-mono text-[10px]">{failedRules.slice(0, 3).join(", ")}</span>
      )}
    </div>
  );
}

// ── Collapsible YAML inline preview ────────────────────────────────────────
/*******************************************************************************
 * Function: InlineYamlPreview
 *
 * Performs the Inline Yaml Preview operation on yaml preview for the ChatMessage module.
 ******************************************************************************/
function InlineYamlPreview({ yaml }) {
  const [open, setOpen] = useState(false);
  if (!yaml) return null;
  const lines = yaml.split("\n").length;
  return (
    <div className="mt-2 rounded-xl border border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon icon="mdi:code-braces" className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="flex-1 text-xs font-semibold text-gray-700 dark:text-gray-300">Generated YAML</span>
        <span className="text-[10px] text-gray-400">{lines} lines</span>
        <Icon icon={open ? "mdi:chevron-up" : "mdi:chevron-down"} className="h-3.5 w-3.5 text-gray-400" />
      </button>
      {open && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          <pre className="max-h-64 overflow-auto rounded-b-xl bg-gray-900 p-3 text-[10px] leading-5 text-green-300">
            <code>{yaml}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

function SavedToolResponses({ steps }) {
  if (!Array.isArray(steps)) return null;
  const receipts = steps.filter(step => step.result !== null && step.result !== undefined).slice(0, 64);
  if (!receipts.length) return null;
  return <details className="mt-3 border-t border-gray-100 pt-2 text-xs dark:border-gray-800">
    <summary className="cursor-pointer text-gray-500">Saved tool responses · {receipts.length}</summary>
    <div className="mt-3 space-y-3">{receipts.map((step, index) => <section key={index} className="border-l border-gray-200 pl-3 dark:border-gray-700">
      <p className="mb-2 font-medium">{step.toolName || step.displayName || "Tool"} · {step.status === "NOT_FOUND" ? "ERP record not found" : step.status === "FAILED" || step.error || step.result?.isError === true ? "Failure response" : step.status === "SUCCEEDED" ? "Confirmed read response" : "Recorded response"}</p>
      <ReadableResult value={step.result} />
    </section>)}</div>
    {steps.filter(step => step.result !== null && step.result !== undefined).length > 64 && <p className="mt-2 text-gray-500">Additional responses exceed this display preview.</p>}
  </details>;
}

// ── Action agent step list (TOOL_CALL intent) ──────────────────────────────
/*******************************************************************************
 * Function: ActionStepsList
 *
 * Performs the Action Steps List operation on steps list for the ChatMessage module.
 ******************************************************************************/
function ActionStepsList({ steps, blocked }) {
  const [open, setOpen] = useState(false);
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return (
    <div className="mt-2 rounded-xl border border-violet-100 dark:border-violet-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon icon={blocked ? "mdi:shield-alert" : "mdi:check-all"} className={`h-3.5 w-3.5 shrink-0 ${blocked ? "text-amber-500" : "text-violet-500"}`} />
        <span className="flex-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
          {steps.length} action{steps.length !== 1 ? "s" : ""}{blocked ? " · blocked" : " · executed"}
        </span>
        <Icon icon={open ? "mdi:chevron-up" : "mdi:chevron-down"} className="h-3.5 w-3.5 text-gray-400" />
      </button>
      {open && (
        <div className="border-t border-violet-100 px-3 pb-2 pt-1.5 dark:border-violet-900/40">
          <div className="space-y-1">
            {steps.map((step, i) => <ActionStepRow key={i} step={step} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/*******************************************************************************
 * Function: ActionStepRow
 *
 * One tool-call step in the chat's action list. When the step's arguments
 * carry an "html" field (e.g. send-email's body), shows a "Preview" toggle
 * that renders the actual HTML — sandboxed in an iframe with no script
 * execution — instead of leaving it as an unreadable escaped-markup string.
 ******************************************************************************/
function ActionStepRow({ step }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const html = typeof step.arguments?.html === "string" && step.arguments.html.trim() !== "" ? step.arguments.html : null;

  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2">
        <Icon
          icon={step.governanceStatus === "blocked" ? "mdi:shield-alert" : step.error ? "mdi:alert-circle" : step.isReadOnly ? "mdi:eye-outline" : "mdi:check-circle"}
          className={`h-3 w-3 shrink-0 ${step.governanceStatus === "blocked" ? "text-amber-500" : step.error ? "text-red-500" : "text-emerald-500"}`}
        />
        <span className="font-semibold text-gray-700 dark:text-gray-300">{step.displayName ?? step.toolName}</span>
        {step.governanceReason && <span className="truncate text-gray-400">{step.governanceReason}</span>}
        {step.error && <span className="truncate text-red-400">{step.error}</span>}
        {html && (
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-gray-200 px-2 py-0.5 font-semibold text-gray-500 hover:border-primary hover:text-primary dark:border-gray-700 dark:text-gray-400"
          >
            <Icon icon="mdi:file-code-outline" className="h-3 w-3" />
            {previewOpen ? "Hide" : "Preview"}
          </button>
        )}
      </div>
      {html && previewOpen && (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700">
          <iframe
            title={`${step.displayName ?? step.toolName} preview`}
            srcDoc={html}
            sandbox=""
            className="h-48 w-full"
          />
        </div>
      )}
    </div>
  );
}

// ── View in Canvas handoff button (query / tool-call results) ──────────────
/*******************************************************************************
 * Function: CanvasHandoffButton
 *
 * Performs the Canvas Handoff Button operation on handoff button for the ChatMessage module.
 ******************************************************************************/
function CanvasHandoffButton({ workflowDraft, toolSteps, userPrompt }) {
  const navigate = useNavigate();
  const [sent, setSent] = useState(false);
  if (!workflowDraft || !Array.isArray(toolSteps) || toolSteps.length === 0) return null;
  function handleClick() {
    saveWorkflowForCanvas({ yaml: workflowDraft, name: userPrompt?.slice(0, 60) || "Chat Workflow", description: "Saved from chat" });
    setSent(true);
    navigate("/workflows/canvas");
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={sent}
      className="mt-3 flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-60 dark:border-indigo-800/40 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
    >
      <Icon icon="mdi:vector-square" className="h-3.5 w-3.5 shrink-0" />
      {sent ? "Opening canvas…" : `View in Canvas (${toolSteps.length} step${toolSteps.length !== 1 ? "s" : ""})`}
    </button>
  );
}

// ── Open saved workflow button ────────────────────────────────────────────
/*******************************************************************************
 * Function: OpenWorkflowButton
 *
 * Performs the Open Workflow Button operation on workflow button for the ChatMessage module.
 ******************************************************************************/
function OpenWorkflowButton({ workflowId }) {
  const navigate = useNavigate();
  const workspace = useChatWorkspace();
  return (
    <button
      type="button"
      onClick={() => workspace?.openWorkflow ? workspace.openWorkflow(workflowId) : navigate(`/workflows/${encodeURIComponent(workflowId)}`)}
      className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
    >
      <Icon icon="mdi:open-in-app" className="h-3.5 w-3.5 shrink-0" />
      {workspace?.openWorkflow ? "Open in canvas" : "Open Workflow"}
    </button>
  );
}

function AutomationRequestBanner({ request, composition }) {
  if (!request || request.profile !== "recurring-delivery-request/v1") return null;
  const recipient = request.requestedAddresses?.length === 1 ? request.requestedAddresses[0] : "Recipient unresolved";
  const mapped = Array.isArray(composition?.mappedSteps) ? composition.mappedSteps : [];
  const requirements = Array.isArray(composition?.remainingRequirements) ? composition.remainingRequirements : request.requirements;
  const hasComposition = composition?.profile === "recurring-automation-composition/v1";
  return <section aria-label="Recurring automation requirements" className="mt-3 border-l-2 border-amber-400 pl-3 text-xs leading-5 text-gray-700 dark:border-amber-500 dark:text-gray-200">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <p className="font-semibold text-gray-900 dark:text-white">{request.cadence === "custom" ? "Recurring" : `${request.cadence[0]?.toUpperCase()}${request.cadence?.slice(1)}`} automation</p>
      <span className="text-amber-700 dark:text-amber-300">· {hasComposition ? "Draft composed" : "Setup required"} · no schedule active</span>
    </div>
    <p className="mt-1 text-gray-500 dark:text-gray-400">Channel: {request.channel} · Recipient: {recipient}</p>
    {request.analysisRequested && <p className="mt-1 text-gray-500 dark:text-gray-400">{composition?.analysis?.status === "MAPPED" ? "Analysis mapped for each requested report · not executed" : "Requested report analysis still needs setup"}</p>}
    {mapped.length > 0 && <div className="mt-2">
      <p className="font-semibold text-gray-800 dark:text-gray-200">Mapped workflow steps</p>
      <ul className="mt-1 space-y-1 text-gray-600 dark:text-gray-300">{mapped.map((step) => <li key={`${step.stepId}-${step.tool}`} className="flex gap-2">
        <span className="w-14 shrink-0 capitalize text-gray-400">{step.capability}</span><span>{step.stepId} · {step.resource ? `${step.resource} · ` : ""}{step.tool}{step.capability === "analysis" && step.sourceStepId ? ` · from ${step.sourceStepId}` : ""}</span>
      </li>)}</ul>
    </div>}
    {Array.isArray(requirements) && requirements.length > 0 && <><p className="mt-2 font-semibold text-gray-800 dark:text-gray-200">Resolve before publication</p><ul className="mt-1 list-disc space-y-1 pl-5 text-gray-600 dark:text-gray-300">{requirements.map((item) => <li key={item}>{item}</li>)}</ul></>}
  </section>;
}

// ── Main ChatMessage ────────────────────────────────────────────────────────
/*******************************************************************************
 * Function: ChatMessage
 *
 * Performs the Chat Message operation on message for the ChatMessage module.
 ******************************************************************************/
function ErpAccessReviewButton({ busy, label = "Review ERP tool access" }) {
  const navigate = useNavigate();
  return <button type="button" disabled={busy} onClick={() => navigate("/registry/tools")} className="mt-2 rounded-lg border border-amber-400 px-3 py-1.5 font-semibold disabled:opacity-50">{label}</button>;
}

function ChatMessage({ message, indexedAttachment, onChatChanged, onRevise, onContinue, onUseDocumentForWorkflow, busy, draftStorageKey, canManageErpAccess = false, isLatestAssistant = false }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const artifacts = message.artifacts;
  const intent = artifacts?.intent;

  // ── System message (execution analysis, background) ──
  if (isSystem) {
    return (
      <div className="flex flex-col items-start gap-1 pl-1">
        <div className="flex max-w-[92%] gap-2.5 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-darkBackgroundVery">
          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700">
            <Icon icon="mdi:robot-outline" className="h-3 w-3 text-gray-600 dark:text-gray-300" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Analysis</p>
            <MessageMarkdown text={message.text} />
            {artifacts?.visualisation && <InlineVisualisation vis={artifacts.visualisation} />}
          </div>
        </div>
        {message.createdAt && (
          <span className="px-1 text-[10px] text-gray-400">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    );
  }

  // ── User message ──
  if (isUser) {
    return (
      <div id={`chat-message-${encodeURIComponent(message.id || "")}`} className="flex flex-col items-end gap-1">
        {message.requestRevision && <p className="text-xs text-gray-500">Revised request · <a className="underline" href={`#chat-message-${encodeURIComponent(message.requestRevision.messageId)}`}>original kept in history</a></p>}
        <div className="min-w-0 max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm leading-6 text-white [overflow-wrap:anywhere]">
          <p className="whitespace-pre-wrap">{message.text}</p>
          {artifacts?.attachment?.filename && <p className="mt-2 flex items-center gap-2 text-xs opacity-80"><Icon icon="mdi:paperclip" aria-hidden="true" />{artifacts.attachment.filename}</p>}
        </div>
        {message.createdAt && (
          <span className="px-1 text-[10px] text-gray-400">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <ChatRequestRevision message={message} onRevise={onRevise} busy={busy} draftStorageKey={draftStorageKey} />
      </div>
    );
  }

  // ── Assistant message ──
  const isWorkflow = intent === "WORKFLOW" || (artifacts && artifacts.yaml);
  const isQuery = intent === "QUERY" || intent === "AUDIT";
  const isToolCall = intent === "TOOL_CALL";

  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-1 pl-1">
      {/* Avatar row */}
      <div className="mb-0.5 flex items-center gap-1.5">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-3 w-3 text-primary" />
        </div>
        <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">
          {intent === "EMAIL_DELIVERY" ? "Delivery draft" : isQuery ? "Data Agent" : isToolCall ? "Action Agent" : "Workflow Assistant"}
        </span>
        {message.createdAt && (
          <span className="text-[10px] text-gray-400">
            · {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      {/* Message body — no bubble, flows like Claude Code */}
      <div className="min-w-0 max-w-[92%] [overflow-wrap:anywhere]">
        <MessageMarkdown text={message.text} />
        {artifacts?.chatAttachment && <ChatAttachmentReview attachment={artifacts.chatAttachment} indexed={indexedAttachment} busy={busy} onSaved={onChatChanged} onUseForWorkflow={onUseDocumentForWorkflow} />}
        {artifacts?.code === "DOCUMENT_BRIDGE_REVIEW_REQUIRED" && <div role="note" aria-label="Document retrieval access" className="mt-3 space-y-2 border-l-2 border-amber-400 pl-3 text-xs">
          <p className="font-semibold">Document stored · ERP retrieval needs review</p>
          <p>No record creation or workflow execution is waiting for approval. The document tool contract must be ready first.</p>
          {canManageErpAccess ? <ErpAccessReviewButton busy={busy} label="Review ERP document access" /> : <p>Ask your platform administrator to review document retrieval. Keep the original upload; do not enter service tokens in chat.</p>}
        </div>}
        {artifacts?.code === "NO_APPROVED_READ_TOOLS" && <div role="note" aria-label="ERP tool access" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-semibold">ERP request not run · Tool access needs review</p>
          <p className="mt-1">Connection access, role grants and the current tool contract must all match. No tool is approved automatically.</p>
          {canManageErpAccess ? <ErpAccessReviewButton busy={busy} /> :
            <p className="mt-2">Ask your platform administrator to review the required capability. Your ERP token may also limit access.</p>}
        </div>}
        <ToolProposalChecks corrections={artifacts?.proposalCorrections} />
        {intent === "WORKFLOW_PATCH_PROPOSAL" && artifacts?.proposal?.scope === "workflow" && <ChatWorkflowReview proposal={artifacts.proposal} busy={busy} />}
        {intent === "WORKFLOW_CONTROL" && artifacts?.workflowControl?.profile === "workflow-control-handoff/v1" && <ChatWorkflowReview control={artifacts.workflowControl} busy={busy} />}
        {Array.isArray(artifacts?.erpActionProposals) && artifacts.erpActionProposals.filter(action => action?.profile === "erp-chat-action/v1").map(action => <ChatErpActionCard key={action.id} action={action} busy={busy} onSaved={onChatChanged} />)}
        {artifacts?.discussion?.profile === "workflow-discussion/v1" && <p role="status" className="mt-2 text-xs text-gray-500">Workflow explanation · draft v{artifacts.discussion.draftVersion} · Explanation only</p>}
        {artifacts?.conversationRecall?.profile === "chat-history-recall/v1" && <p role="status" className="mt-2 text-xs text-gray-500">Earlier messages recalled from this conversation · Historical context, not a new ERP lookup</p>}
        {artifacts?.workspaceStatus?.profile === "chat-workspace-status/v1" && <ChatRunRecovery status={artifacts.workspaceStatus} selectedExecutionId={artifacts.recoveryGuidance?.executionId} />}

        {["erpbridge", "local_model"].includes(artifacts?.policyCheck?.source) && <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          <p role="status">Policy check · {artifacts.policyCheck.source === "erpbridge" ? "ERPBridge" : "Local JSON / model"} · {artifacts.policyCheck.failureCode ? "Check failed" : ({ allow: "Allowed", deny: "Denied", review: "Needs review", unavailable: "Unavailable" })[artifacts.policyCheck.decision] || "Not confirmed"}{artifacts.policyCheck.fallbackUsed ? " · Fallback used" : ""}</p>
          {typeof artifacts.policyCheck.reason === "string" && <p className="mt-1">{artifacts.policyCheck.reason}</p>}
        </div>}

        {artifacts?.modelRouting?.fallbackUsed === true && typeof artifacts.modelRouting.model === "string" && <p role="status" className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Answered with backup model · {artifacts.modelRouting.model}
        </p>}

        {intent === "EMAIL_DELIVERY" && artifacts?.emailDraft && <EmailDraftPreview draft={artifacts.emailDraft} emailDelivery={artifacts.emailDelivery} reportReason={artifacts.reportReason} superseded={artifacts.emailDraftSuperseded} onSaved={onChatChanged} onContinue={onContinue} busy={busy} />}
        {isLatestAssistant && intent === "EMAIL_DELIVERY" && onContinue && !artifacts?.emailDraft && !artifacts?.erpActionProposals?.length && <EmailPreparationHelp onContinue={onContinue} busy={busy} />}

        {intent === "NODE_PATCH_PROPOSAL" && artifacts?.proposal && <p className="mt-2 text-xs text-gray-500">
          {artifacts.proposal.status === "APPLIED" ? `Applied to draft v${artifacts.proposal.appliedVersion} · not published or executed by this decision.` : artifacts.proposal.status === "DISCARDED" ? "Proposal discarded · workflow unchanged by this decision." : `Pending node proposal · ${artifacts.proposal.nodeId}. Review it in the workflow canvas.`}
        </p>}
        {intent === "NODE_PATCH_PROPOSAL" && artifacts?.proposal?.command?.type === "updateProtected" && artifacts.proposal.command.patch?.output && !artifacts.proposal.command.patch.onError && <details className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800"><summary className="cursor-pointer text-xs font-medium text-primary">Review protected output mappings</summary><ProtectedPatchPreview proposal={artifacts.proposal} /></details>}

        {/* ── Query: inline sources + chart only ── */}
        {isQuery && (
          <>
            {artifacts?.visualisation && <InlineVisualisation vis={artifacts.visualisation} />}
            <InlineSources sources={artifacts?.sources} boundHit={artifacts?.boundHit} />
          </>
        )}

        {/* ── Tool call: action steps only — no canvas handoff (direct actions, not workflow creation) ── */}
        {isToolCall && (
          <ActionStepsList steps={artifacts?.steps} blocked={artifacts?.blocked} />
        )}
        <SavedToolResponses steps={artifacts?.toolSteps ?? artifacts?.steps} />

        {/* ── Workflow: inline validation + YAML preview + save-after-edit ── */}
        {isWorkflow && (
          <>
            <AutomationRequestBanner request={artifacts?.automationRequest} composition={artifacts?.automationComposition} />
            {Array.isArray(artifacts?.missing_tools) && artifacts.missing_tools.length > 0 && (
              <div className="mt-2 flex flex-col gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800/40 dark:bg-amber-900/20">
                <div className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300">
                  <Icon icon="mdi:alert-circle-outline" className="h-3.5 w-3.5 shrink-0" />
                  Some steps use tools not available in your ERP system
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {artifacts.missing_tools.map((t) => (
                    <span key={t} className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t}</span>
                  ))}
                </div>
                <p className="text-[10px] text-amber-600 dark:text-amber-400">Execution is blocked until required capabilities are available. Keep the requested outcomes visible while resolving them.</p>
              </div>
            )}
            <ValidationBadge artifact={artifacts} failedRules={artifacts?.validation?.failed_rules ?? []} />
            <WorkflowDraftHelp artifact={artifacts} busy={busy} />
            <InlineYamlPreview yaml={artifacts?.yaml || artifacts?.selected_workflow_yaml} />
            {artifacts?.workflowId && <OpenWorkflowButton workflowId={artifacts.workflowId} />}
            {artifacts?.generationApproval && <PendingGenerationApprovalCard pending={artifacts.generationApproval} />}
          </>
        )}
      </div>
    </div>
  );
}

export default ChatMessage;
