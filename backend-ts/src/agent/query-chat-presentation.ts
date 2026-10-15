import type { StoredChatInput } from "./chat-context.js";
import type { QueryLoopResult, ToolStep } from "./query-loop.js";
import type { ChatOperation } from "../repository/store.js";
import type { PolicyDecision } from "../governance/optional-policy.js";

/** Pure shared presentation: resident and phased chat retain the same history,
 * workflow context, policy notices, narrative rejection and artifact meaning. */
export function queryChatHistory(body: Record<string, unknown>, stored: StoredChatInput, policy: PolicyDecision) {
  const context = body.workflowContext as { yaml?: unknown; name?: unknown } | undefined;
  const yaml = typeof context?.yaml === "string" ? context.yaml.trim() : "";
  const name = typeof context?.name === "string" && context.name ? context.name : "Workflow";
  const history = yaml ? [`assistant: I have the following workflow loaded for context:\n**${name}**\n\`\`\`yaml\n${yaml}\n\`\`\``, ...stored.priorMessages] : stored.priorMessages;
  const augmented = policy.source === "skipped" ? history : [...history,
    `assistant: Additional policy preflight (${policy.source}): ${policy.reason}. This is not execution permission; mandatory validation and approvals remain required.`];
  return augmented.map(line => { const separator = line.indexOf(": "); return separator > -1 ? { role: line.slice(0, separator), text: line.slice(separator + 2) } : { role: "user", text: line }; });
}

export function buildWorkflowYamlFromSteps(steps: ToolStep[], userPrompt: string): string {
  const name = userPrompt.trim().slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Chat Workflow";
  const yaml = steps.map((step, index) => {
    const description = step.toolName.replace(/_/g, " ").replace(/\b\w/g, character => character.toUpperCase());
    const parameters = Object.keys(step.arguments).length ? "\n    parameters:\n" + Object.entries(step.arguments).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`).join("\n") : "";
    return `  - id: step_${index + 1}\n    action: ${step.toolName}\n    description: "${description}"${parameters}`;
  }).join("\n");
  return `name: "${name}"\ndescription: "Saved from chat session"\ntrigger:\n  type: manual\nsteps:\n${yaml}`;
}

export function queryChatPresentation(intent: string, content: string, binding: ChatOperation["modelBinding"], result: QueryLoopResult) {
  // Retrieval/analysis is a conversation, not implicit authoring. The explicit
  // workflow-generation route owns drafts and canvas updates.
  const workflowDraft: string | undefined = undefined;
  const artifacts = { intent, sources: result.toolCallLog, toolSteps: result.toolSteps, boundHit: result.boundHit, iterationsUsed: result.iterationsUsed,
    latencyMs: result.latencyMs, readOutcome: result.readOutcome, narrativeRejected: result.narrativeRejected,
    ...(result.clarification ? { clarification: result.clarification } : {}),
    ...(result.recoveryGuidance ? { recoveryGuidance: result.recoveryGuidance } : {}),
    ...(result.proposalCorrections?.length ? { proposalCorrections: result.proposalCorrections } : {}),
    ...(result.modelRouting ? { modelRouting: result.modelRouting } : {}), ...(result.visualisation ? { visualisation: result.visualisation } : {}),
    ...(workflowDraft ? { workflowDraft } : {}) };
  const answerBinding = binding ? { ...binding, ...(result.modelRouting ? { model: result.modelRouting.model,
    requestedModel: result.modelRouting.requestedModel, fallbackUsed: result.modelRouting.fallbackUsed } : {}) } : null;
  return { artifacts, answerBinding, workflowDraft };
}
