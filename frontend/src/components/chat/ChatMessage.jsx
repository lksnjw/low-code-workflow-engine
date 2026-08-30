import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@iconify/react";
import MessageMarkdown from "./MessageMarkdown";
import { saveWorkflowForCanvas, peekWorkflowForChatEdit, clearWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";
import { workflowService } from "../../services/workflow.service";

// ── Inline validation badge ─────────────────────────────────────────────────
/*******************************************************************************
 * Function: ValidationBadge
 *
 * Performs the Validation Badge operation on badge for the ChatMessage module.
 ******************************************************************************/
function ValidationBadge({ canExecute, failedRules = [] }) {
  if (canExecute == null) return null;
  return (
    <div className={`mt-2 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
      canExecute
        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300"
        : "border-red-200 bg-red-50 text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-300"
    }`}>
      <Icon icon={canExecute ? "mdi:shield-check" : "mdi:shield-alert"} className="h-3.5 w-3.5 shrink-0" />
      <span className="font-semibold">{canExecute ? "Validation passed — ready to execute" : "Validation blocked"}</span>
      {!canExecute && failedRules.length > 0 && (
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

// ── Inline mini bar chart (recharts-free, pure CSS) ────────────────────────
/*******************************************************************************
 * Function: InlineBarChart
 *
 * Performs the Inline Bar Chart operation on bar chart for the ChatMessage module.
 ******************************************************************************/
function InlineBarChart({ vis }) {
  if (!vis || !Array.isArray(vis.data) || vis.data.length === 0) return null;
/*******************************************************************************
 * Function: max
 *
 * Performs the max operation on the application for the ChatMessage module.
 ******************************************************************************/
  const max = Math.max(...vis.data.map((d) => d.value), 1);
  return (
    <div className="mt-2 rounded-xl border border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-darkBackground">
      <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{vis.title}</p>
      <div className="space-y-1.5">
        {vis.data.slice(0, 10).map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 truncate text-right text-gray-400">{d.label}</span>
            <div className="flex-1 rounded-full bg-gray-100 dark:bg-gray-800" style={{ height: 7 }}>
              <div className="rounded-full bg-primary" style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, height: 7 }} />
            </div>
            <span className="w-10 shrink-0 text-right font-semibold text-gray-700 dark:text-gray-200">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tool call sources (query agent) ────────────────────────────────────────
/*******************************************************************************
 * Function: InlineSources
 *
 * Performs the Inline Sources operation on sources for the ChatMessage module.
 ******************************************************************************/
function InlineSources({ sources, boundHit }) {
  const [open, setOpen] = useState(false);
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return (
    <div className="mt-2 rounded-xl border border-blue-100 dark:border-blue-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon icon="mdi:api" className="h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span className="flex-1 text-xs font-semibold text-blue-700 dark:text-blue-300">
          {sources.length} tool call{sources.length !== 1 ? "s" : ""}
          {boundHit ? " · limit reached" : ""}
        </span>
        <Icon icon={open ? "mdi:chevron-up" : "mdi:chevron-down"} className="h-3.5 w-3.5 text-gray-400" />
      </button>
      {open && (
        <div className="border-t border-blue-100 px-3 pb-2 pt-1.5 dark:border-blue-900/40">
          <div className="space-y-1">
            {sources.map((call, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <Icon icon="mdi:function-variant" className="h-3 w-3 shrink-0 text-blue-400" />
                <code className="font-mono text-blue-700 dark:text-blue-300">{call.name}</code>
                {call.arguments && Object.keys(call.arguments).length > 0 && (
                  <span className="truncate text-gray-400">{JSON.stringify(call.arguments).slice(0, 60)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Save button after WORKFLOW_MODIFY ──────────────────────────────────────
function SaveModifiedWorkflowButton({ yaml, workflowName }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [errorMsg, setErrorMsg] = useState(null);

  const handleSave = useCallback(async () => {
    if (!yaml || status === "saving" || status === "saved") return;
    setStatus("saving");
    setErrorMsg(null);
    try {
      const editCtx = peekWorkflowForChatEdit();
      if (editCtx?.workflowId) {
        await workflowService.saveYAML(editCtx.workflowId, yaml);
      } else {
        await workflowService.create({ name: workflowName || "Modified Workflow", description: "Modified via chat", yaml });
      }
      clearWorkflowForChatEdit();
      setStatus("saved");
    } catch (err) {
      setErrorMsg(err?.response?.data?.message ?? err.message ?? "Save failed");
      setStatus("error");
    }
  }, [yaml, workflowName, status]);

  if (!yaml) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <button
        type="button"
        onClick={handleSave}
        disabled={status === "saving" || status === "saved"}
        className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300"
      >
        <Icon icon={status === "saved" ? "mdi:check" : status === "saving" ? "mdi:loading" : "mdi:content-save"} className={`h-3.5 w-3.5 shrink-0 ${status === "saving" ? "animate-spin" : ""}`} />
        {status === "saved" ? "Saved" : status === "saving" ? "Saving…" : "Save Changes"}
      </button>
      {status === "saved" && (
        <button
          type="button"
          onClick={() => { saveWorkflowForCanvas({ yaml, name: workflowName || "Modified Workflow" }); navigate("/workflows/canvas"); }}
          className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-800/40 dark:bg-indigo-900/20 dark:text-indigo-300"
        >
          <Icon icon="mdi:vector-square" className="h-3.5 w-3.5 shrink-0" />
          View in Canvas
        </button>
      )}
      {errorMsg && <p className="text-[10px] text-red-500">{errorMsg}</p>}
    </div>
  );
}

// ── Action agent step list (TOOL_CALL intent) ──────────────────────────────
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
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <Icon
                  icon={step.governanceStatus === "blocked" ? "mdi:shield-alert" : step.error ? "mdi:alert-circle" : step.isReadOnly ? "mdi:eye-outline" : "mdi:check-circle"}
                  className={`h-3 w-3 shrink-0 ${step.governanceStatus === "blocked" ? "text-amber-500" : step.error ? "text-red-500" : "text-emerald-500"}`}
                />
                <span className="font-semibold text-gray-700 dark:text-gray-300">{step.displayName ?? step.toolName}</span>
                {step.governanceReason && <span className="truncate text-gray-400">{step.governanceReason}</span>}
                {step.error && <span className="truncate text-red-400">{step.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── View in Canvas handoff button (query / tool-call results) ──────────────
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
function OpenWorkflowButton({ workflowId }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/workflows/${workflowId}`)}
      className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
    >
      <Icon icon="mdi:open-in-app" className="h-3.5 w-3.5 shrink-0" />
      Open Workflow
    </button>
  );
}

// ── Main ChatMessage ────────────────────────────────────────────────────────
/*******************************************************************************
 * Function: ChatMessage
 *
 * Performs the Chat Message operation on message for the ChatMessage module.
 ******************************************************************************/
function ChatMessage({ message }) {
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
            {artifacts?.visualisation && <InlineBarChart vis={artifacts.visualisation} />}
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
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm leading-6 text-white">
          <p className="whitespace-pre-wrap">{message.text}</p>
        </div>
        {message.createdAt && (
          <span className="px-1 text-[10px] text-gray-400">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    );
  }

  // ── Assistant message ──
  const isWorkflow = intent === "WORKFLOW" || (artifacts && artifacts.yaml);
  const isQuery = intent === "QUERY" || intent === "AUDIT";
  const isToolCall = intent === "TOOL_CALL";

  return (
    <div className="flex flex-col items-start gap-1 pl-1">
      {/* Avatar row */}
      <div className="mb-0.5 flex items-center gap-1.5">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-3 w-3 text-primary" />
        </div>
        <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">
          {isQuery ? "Data Agent" : isToolCall ? "Action Agent" : "Workflow Assistant"}
        </span>
        {message.createdAt && (
          <span className="text-[10px] text-gray-400">
            · {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      {/* Message body — no bubble, flows like Claude Code */}
      <div className="max-w-[92%]">
        <MessageMarkdown text={message.text} />

        {/* ── Query: inline sources + chart only ── */}
        {isQuery && (
          <>
            {artifacts?.visualisation && <InlineBarChart vis={artifacts.visualisation} />}
            <InlineSources sources={artifacts?.sources} boundHit={artifacts?.boundHit} />
          </>
        )}

        {/* ── Tool call: action steps only — no canvas handoff (direct actions, not workflow creation) ── */}
        {isToolCall && (
          <ActionStepsList steps={artifacts?.steps} blocked={artifacts?.blocked} />
        )}

        {/* ── Workflow: inline validation + YAML preview + save-after-edit ── */}
        {isWorkflow && (
          <>
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
                <p className="text-[10px] text-amber-600 dark:text-amber-400">These steps will fail at runtime. Remove them in the canvas or ask for an alternative.</p>
              </div>
            )}
            <ValidationBadge canExecute={artifacts?.can_execute} failedRules={artifacts?.validation?.failed_rules ?? []} />
            <InlineYamlPreview yaml={artifacts?.yaml || artifacts?.selected_workflow_yaml} />
            {(artifacts?.yaml || artifacts?.selected_workflow_yaml) && peekWorkflowForChatEdit() && (
              <SaveModifiedWorkflowButton
                yaml={artifacts?.yaml || artifacts?.selected_workflow_yaml}
                workflowName={peekWorkflowForChatEdit()?.workflowName}
              />
            )}
            {artifacts?.workflowId && <OpenWorkflowButton workflowId={artifacts.workflowId} />}
          </>
        )}
      </div>
    </div>
  );
}

export default ChatMessage;
