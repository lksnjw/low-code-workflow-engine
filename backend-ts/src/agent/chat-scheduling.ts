import type { IntentRouting } from "./intent-router.js";
import { selectedDiscussionWorkflow } from "./workflow-discussion.js";
import { HandlerFailure, isRecord, nextID, now, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { saveWorkflowSchedule } from "../runner/workflow-schedules.js";
import { prepareOperationExecution } from "../workflows/operation-compilation-lifecycle.js";
import { prepareReadSnapshot } from "../runner/snapshot-schedule.js";
import { isOperationToolNode, type ReadBinding } from "../workflows/compiled-read.js";
import type { RepositoryState, ReportWindowInputBinding, WorkflowSchedule, StoredRecord } from "../repository/store.js";
import type { PolicyDecision } from "../governance/optional-policy.js";
import type { processStoredChat } from "../http/handlers/chat.js";
import { ok } from "../models/schemas.js";

const periods = { daily: "previous-calendar-day", weekly: "previous-calendar-week", monthly: "previous-calendar-month" } as const;
const inputName = (binding: ReadBinding | undefined) => binding?.kind === "ref" && binding.source === "workflowInput" && binding.path.length === 1 ? binding.path[0] : undefined;

/** Derive date fields only from reviewed report contracts and exact compiled
 * input bindings, never field-name heuristics or a model-supplied payload. */
export function chatSchedulePlan(state: Readonly<RepositoryState>, services: HandlerServices, user: CurrentUser, sessionId: string,
  reference: unknown, routing: IntentRouting) {
  const selected = selectedDiscussionWorkflow(state, user, sessionId, reference);
  if (!selected) return { question: "Which saved workflow should run automatically? Select it in the canvas first." };
  const { workflow, hash } = selected, previous = state.schedules[`schedule-${workflow.id}`];
  if (!user.permissions.includes("workflow:write")) return { question: "Your role cannot manage workflow schedules. Ask the workflow manager to schedule this saved workflow." };
  if (routing.workflowControl === "pause" && !previous) return { question: "This workflow has no saved schedule to pause." };
  if (routing.workflowControl !== "pause" && workflow.publishedVersion < 1) return { question: "This workflow is still a draft. Review and publish it before I can turn on automatic runs." };
  const publication = state.versions[workflow.id]?.findLast(value => value.version === workflow.publishedVersion && value.artifactState === "PUBLISHED" && value.yaml === workflow.yaml);
  const snapshotMode = routing.workflowControl === "pause" ? previous?.profile === "workflow-snapshot-schedule/v1" : Boolean(publication?.compiledRead && !publication.compiledOperation);
  if (routing.workflowControl !== "pause" && !publication?.compiledOperation && !snapshotMode) return { question: "Automatic runs need a current reviewed read-only snapshot or a supported date-range report. I have not activated a schedule." };
  const suggested = routing.scheduleSuggestion ?? {}, cadence = suggested.cadence ?? previous?.cadence ?? (previous ? "daily" : undefined);
  const timezone = suggested.timezone ?? previous?.timezone, localTime = suggested.localTime ?? previous?.localTime;
  if (!cadence || !localTime || !timezone) return { question: !timezone ? `Which timezone should I use${localTime ? ` for ${localTime}` : ""}? For example, Asia/Colombo. No schedule is active from this request yet.` :
    "What time and how often should this saved workflow run? For example, every morning at 9. No schedule has been activated yet." };
  const dayOfWeek = cadence === "weekly" ? suggested.dayOfWeek ?? (previous?.cadence === "weekly" ? previous.dayOfWeek : undefined) : undefined;
  const dayOfMonth = cadence === "monthly" ? suggested.dayOfMonth ?? (previous?.cadence === "monthly" ? previous.dayOfMonth : undefined) : undefined;
  if (cadence === "weekly" && dayOfWeek === undefined) return { question: "Which day of the week should it run? No schedule has been activated yet." };
  if (cadence === "monthly" && dayOfMonth === undefined) return { question: "Which day of the month, from 1 to 28, should it run? No schedule has been activated yet." };
  const currentPrevious = previous?.workflowHash === hash && previous.workflowVersion === workflow.publishedVersion ? previous : undefined;
  let reportWindowBinding: ReportWindowInputBinding | undefined = currentPrevious?.reportWindowBinding;
  const input = structuredClone(currentPrevious?.input ?? {});
  if (routing.workflowControl !== "pause" && snapshotMode) {
    try { prepareReadSnapshot(state, services, publication!, workflow, user.role, input); }
    catch { return { question: "This snapshot needs a current reviewed publication and complete run inputs before I can schedule it. No schedule was activated." }; }
  }
  if (routing.workflowControl !== "pause" && !snapshotMode) {
    const compiled = prepareOperationExecution(state, services, publication!, workflow.yaml, user.role), candidates = new Map<string, ReportWindowInputBinding>();
    for (const node of compiled.plan.ir.root.nodes) {
      if (!isOperationToolNode(node) || node.effectClass !== "read" || node.inputs.kind !== "object") continue;
      const tool = services.registries.snapshot().tools.find(tool => tool.tool_id === node.capability.toolId), contract = tool?.report_coverage_contract;
      if (!contract) continue;
      const start = inputName(node.inputs.fields[contract.start_parameter]), end = inputName(node.inputs.fields[contract.end_parameter]);
      if (start && end && start !== end) candidates.set(`${start}:${end}`, { profile: "workflow-report-window-input-binding/v1", startAtInput: start, endAtInput: end });
    }
    if (!reportWindowBinding && candidates.size === 1) reportWindowBinding = [...candidates.values()][0];
    if (!reportWindowBinding) return { question: "This report has no unambiguous date-range setup for automatic runs. Review its schedule settings before activating it." };
    const required = compiled.plan.ir.inputSchema?.required as string[] | undefined;
    const missing = (required ?? []).filter(name => ![reportWindowBinding!.startAtInput, reportWindowBinding!.endAtInput].includes(name) && !Object.hasOwn(input, name));
    if (missing.length) return { question: "This report needs additional run inputs. Review the schedule settings and fill its required business values; I have not guessed them or activated anything." };
  }
  return { workflowId: workflow.id, name: workflow.name, command: { profile: snapshotMode ? "workflow-snapshot-schedule-command/v1" : "workflow-calendar-schedule-command/v2", baseRevision: previous?.revision ?? 0,
    workflowVersion: workflow.publishedVersion || previous!.workflowVersion, workflowHash: hash, enabled: routing.workflowControl !== "pause",
    cadence, timezone, localTime, ...(dayOfWeek === undefined ? {} : { dayOfWeek }), ...(dayOfMonth === undefined ? {} : { dayOfMonth }),
    reportingPeriod: snapshotMode ? "snapshot" : periods[cadence], misfirePolicy: previous?.misfirePolicy ?? "SKIP", misfireGraceSeconds: previous?.misfireGraceSeconds ?? 900,
    servicePrincipalId: user.id, input, reportWindowBinding: reportWindowBinding ?? null } };
}

/** Saving the schedule and chat receipt is one authoritative commit. A lost
 * acknowledgement cannot turn into a second schedule or a fabricated reply. */
export async function tryChatSchedule(input: Parameters<typeof processStoredChat>[0], routing: IntentRouting, policy?: PolicyDecision) {
  const { body, user, services, sessionId, traceId, hooks, stored } = input;
  const reference = isRecord(body.nodeContext) ? { workflowId: body.nodeContext.workflowId, baseVersion: body.nodeContext.baseVersion, baseHash: body.nodeContext.baseHash } : body.workflowContext;
  const plan = await services.repository.readAuthoritative(state => { hooks?.assertCurrent(state as RepositoryState); return chatSchedulePlan(state, services, user, sessionId, reference, routing); });
  if (!plan.command) return { question: plan.question };
  await hooks?.beforeCommit?.();
  let message: StoredRecord | undefined;
  const saveReceipt = (state: RepositoryState, schedule: WorkflowSchedule) => {
    hooks?.assertCurrent(state);
    const chat = assertChatAuthority(state, user, sessionId);
    const paused = schedule.state === "PAUSED";
    message = { id: nextID(state, "msg"), role: "assistant", createdAt: now(), traceId,
      text: paused ? `The automatic schedule for **${plan.name}** is paused. No new run was started by this request.` :
        `**${plan.name}** is scheduled ${schedule.cadence ?? "daily"} at **${schedule.localTime} (${schedule.timezone})**. Next run: ${schedule.nextRunAt}. It will run in the background. Any required ERP approval remains required; activation is not proof that a run has completed.`,
      artifacts: { intent: "WORKFLOW_CONTROL", workflowId: plan.workflowId, toolsDispatched: false, intentRouting: routing,
        ...(policy && policy.source !== "skipped" ? { policyCheck: policy } : {}),
        workflowControl: { profile: "workflow-control-handoff/v1", workflowId: plan.workflowId, name: plan.name, action: routing.workflowControl,
          actorId: user.id, canEdit: true, scheduleSupported: true, scheduleState: schedule.state, scheduleRevision: schedule.revision,
          scheduleCommandApplied: true, nextRunAt: schedule.nextRunAt } } };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); hooks?.saved(state, message);
  };
  await saveWorkflowSchedule(services, plan.workflowId, user, plan.command,
    { assertCurrent: state => { hooks?.assertCurrent(state); assertChatAuthority(state, user, sessionId); }, saved: saveReceipt });
  if (!message) throw new HandlerFailure(503, "Schedule save outcome is unconfirmed. Refresh its saved status before another request.");
  return { response: ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: message, answer: message.text, intent: "WORKFLOW_CONTROL" }, "Schedule and conversation receipt saved; no ERP tool dispatched by this request", { traceId }) };
}
