import { ok } from "../models/schemas.js";
import { workflowDiscussionSnapshot } from "./workflow-discussion.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { HandlerFailure, isRecord, nextID, now } from "../http/handlers/common.js";
import type { IntentRouting } from "./intent-router.js";
import type { processStoredChat } from "../http/handlers/chat.js";
import type { RepositoryState } from "../repository/store.js";
import type { PolicyDecision } from "../governance/optional-policy.js";
import { tryChatSchedule } from "./chat-scheduling.js";

/** Lifecycle instructions never masquerade as YAML edits or ERP writes. The
 * exact server-owned run/publish/schedule endpoint still admits the decision. */
export async function processWorkflowControl(input: Parameters<typeof processStoredChat>[0], routing: IntentRouting | undefined,
  mutate: <T>(work: (state: RepositoryState) => T) => Promise<T>, policy?: PolicyDecision) {
  const { services, user, body, sessionId, stored, traceId } = input;
  // Pattern-mode fallback opens generic controls only; it cannot infer a time,
  // timezone, publication, record identity or execution authorization.
  const action = routing?.workflowControl ?? "review";
  let question: string | undefined;
  if (routing && ["schedule", "pause"].includes(action)) {
    try {
      const scheduled = await tryChatSchedule(input, routing, policy);
      if (scheduled.response) return scheduled.response;
      question = scheduled.question;
    } catch (error) {
      if (!(error instanceof HandlerFailure) || error.status >= 500 || error.status === 403) throw error;
      question = "I could not activate that schedule with the current workflow settings. Review the saved schedule controls and required report inputs. Nothing was automatically retried.";
    }
  }
  const assistantMessage = await mutate(state => {
    const chat = assertChatAuthority(state, user, sessionId);
    const reference = isRecord(body.nodeContext) ? { workflowId: body.nodeContext.workflowId, baseVersion: body.nodeContext.baseVersion, baseHash: body.nodeContext.baseHash } : body.workflowContext;
    const snapshot = workflowDiscussionSnapshot(state, user, sessionId, reference, services.registries.snapshot().tools);
    let text = "Which saved workflow do you mean? Select it in the canvas, then ask me to run, schedule or change it. Nothing has been executed or scheduled.";
    let control;
    if (snapshot) {
      const publication = state.versions[snapshot.workflowId]?.find(item => item.version === snapshot.publishedVersion && item.artifactState === "PUBLISHED");
      const scheduleSupported = Boolean(publication?.compiledOperation);
      const instructions = {
        review: "Review the saved workflow and its current issues in the canvas controls.",
        publish: "Review the draft, then choose Publish reviewed draft. Publishing does not start a run.",
        run: "Review the inputs in the canvas controls, then choose Run published version. Any required approval will appear when the run reaches it.",
        schedule: scheduleSupported ? "Review the time, timezone and reporting period below before activating automatic runs." :
          "Automatic runs are not available for this workflow yet. You can run it manually; the current scheduler requires a published report with supported date-range inputs. Changing the workflow's trigger text will not activate a schedule.",
        pause: snapshot.schedule ? "Open the schedule controls below and choose Pause schedule to confirm the change." : "This workflow has no saved schedule to pause.",
      };
      text = `**${snapshot.name}**\n\n${question ?? instructions[action]}\n\nThis message has not run, published or changed the workflow or its schedule.`;
      control = { profile: "workflow-control-handoff/v1", workflowId: snapshot.workflowId, name: snapshot.name, action,
        baseVersion: snapshot.draftVersion, baseHash: snapshot.contentHash, publishedVersion: snapshot.publishedVersion,
        actorId: user.id, canEdit: user.permissions.includes("workflow:write"), scheduleSupported,
        ...(routing?.scheduleSuggestion ? { scheduleSuggestion: routing.scheduleSuggestion } : {}),
        scheduleState: snapshot.schedule?.state ?? null };
    }
    const message = { id: nextID(state, "msg"), role: "assistant", text, createdAt: now(), traceId,
      artifacts: { intent: "WORKFLOW_CONTROL", ...(control ? { workflowId: control.workflowId, workflowControl: control, ...(question ? { needsClarification: true } : {}) } : { needsClarification: true }), toolsDispatched: false } };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return message;
  });
  return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: assistantMessage.text, intent: "WORKFLOW_CONTROL" }, "Saved workflow controls prepared; no command executed", { traceId });
}
