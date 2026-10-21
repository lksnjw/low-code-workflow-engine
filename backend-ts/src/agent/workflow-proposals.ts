import { toolRoleAllowed } from "../governance/tool-access.js";
import { z } from "zod";
import { ok } from "../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { assertCurrentWorkflowEditor, applyWorkflowCommand, requireWorkflowBase } from "../workflows/commands.js";
import { validateWorkspaceDraft } from "../workflows/draft-validation.js";
import { readAuthoringContract } from "../workflows/read-authoring.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { HandlerFailure, nextID, now } from "../http/handlers/common.js";
import { selectedDiscussionWorkflow } from "./workflow-discussion.js";
import { promptData } from "../prompts/contracts.js";
import { withoutSecretFields } from "../redact/secrets.js";
import type { processStoredChat } from "../http/handlers/chat.js";
import type { RepositoryState } from "../repository/store.js";
import { runWorkflowAuthoringAgent } from "./workflow-authoring-agent.js";
import { generatedInputBindingIssues } from "../workflows/generated-input-validation.js";
import { withWorkspaceCompilationIssues } from "../workflows/draft-validation.js";
import { discoverTools } from "./tool-discovery.js";
import { reviewedReadOutputKey } from "../tools/mcp-result.js";

const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proposal"), yaml: z.string().trim().min(1).max(200_000), summary: z.string().trim().min(1).max(800) }).strict(),
  z.object({ kind: z.literal("clarification"), question: z.string().trim().min(1).max(500) }).strict(),
]);
export function parseWorkflowProposal(text: string) {
  const value = resultSchema.parse(JSON.parse(text));
  if (value.kind === "proposal") parseWorkflowYAMLStrict(value.yaml);
  return value;
}

type Input = Parameters<typeof processStoredChat>[0];
type Mutation = <T>(work: (state: RepositoryState) => T) => Promise<T>;
const overview = (yaml: string) => {
  const plan = parseWorkflowYAMLStrict(yaml);
  return { name: plan.name, description: plan.description, steps: plan.steps.map(step => ({ id: step.id, label: step.description ?? step.id, kind: step.kind ?? "tool", action: step.action })) };
};

/** Whole-workflow edits use the same exact, revision-bound Apply command as
 * node edits. Model text never saves, publishes, runs or schedules a workflow. */
export async function processWorkflowProposal(input: Input, mutate: Mutation) {
  const { services, user, body, sessionId, traceId, content, signal, hooks, stored } = input;
  const selected = await services.repository.readAuthoritative(state => {
    hooks?.assertCurrent(state as RepositoryState);
    const selected = selectedDiscussionWorkflow(state, user, sessionId, body.workflowContext);
    if (!selected) return null;
    assertCurrentWorkflowEditor(state, selected.workflow, user);
    return structuredClone(selected);
  });
  const reply = async (text: string, artifacts: Record<string, unknown>) => {
    const assistantMessage = await mutate(state => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", text, createdAt: now(), traceId, artifacts, modelBinding: services.providerRuntime?.binding ?? null };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return message;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: text, intent: "WORKFLOW_MODIFY" }, "Workflow change request processed; nothing executed", { traceId });
  };
  if (!selected) return reply("Which saved workflow should I change? Select it in the canvas, then describe the change. I have not created or changed a workflow.", { intent: "CONVERSATION", needsClarification: true, toolsDispatched: false });
  if (selected.workflow.yaml.length > 200_000) return reply("This workflow is too large to review in one request. Select the step you want to change and describe that change in chat.", { intent: "CONVERSATION", workflowId: selected.workflow.id, needsClarification: true, toolsDispatched: false });
  if (!services.providerRuntime?.configured) return reply("Choose an available chat model before asking me to change this workflow. Your saved workflow is unchanged.", { intent: "WORKFLOW_MODIFY_ERROR", toolsDispatched: false });
  const { workflow, hash } = selected, baseVersion = workflow.draftVersion;
  let tools;
  try { tools = (await discoverTools(services.erpbridgeSession ?? null, services.registries)).filter(tool => toolRoleAllowed(tool.allowed_roles, user.role)); }
  catch { return reply("I could not verify the current ERP tool connection before editing. Check its connection and reviewed tool access, then retry this change. Your saved workflow is unchanged.", { intent: "WORKFLOW_MODIFY_ERROR", code: "WORKFLOW_TOOLS_UNAVAILABLE", toolsDispatched: false }); }
  if (!tools.length) return reply("No reviewed ERP tools are currently available for your role. Check the connection and tool access before building this change. Your saved workflow is unchanged.", { intent: "WORKFLOW_MODIFY_ERROR", code: "WORKFLOW_TOOLS_UNAVAILABLE", toolsDispatched: false });
  const registryHash = services.registries.hash();
  const prompt = promptData({ instruction: content, currentYaml: workflow.yaml,
    recentConversation: stored.priorMessages.slice(-6).map(value => value.slice(0, 2500)),
    tools: tools.filter(tool => toolRoleAllowed(tool.allowed_roles, user.role)).map(tool => withoutSecretFields({ name: tool.name,
      description: tool.description, inputSchema: tool.input_schema, outputSchema: tool.bridge_contract?.output_schema, readOnly: tool.is_read_only,
      resultBinding: { path: [reviewedReadOutputKey(tool)], schema: tool.bridge_contract?.output_schema },
      riskLevel: tool.risk_level, operationContract: tool.operation_contract, readErrorContract: tool.read_error_contract,
      reportCoverageContract: tool.report_coverage_contract, connectionId: tool.connection_id })),
    authoring: readAuthoringContract(parseWorkflowYAMLStrict(workflow.yaml), tools, user.role, registryHash) });
  if (Buffer.byteLength(prompt, "utf8") > 320_000) return reply("There is too much workflow context for a reliable whole-workflow edit. Select the step you want to change, then tell me what it should do.", { intent: "CONVERSATION", workflowId: workflow.id, needsClarification: true, toolsDispatched: false });
  await hooks?.stage("GENERATING_WORKFLOW_PROPOSAL");
  let generated;
  try {
    generated = await runWorkflowAuthoringAgent({ prompt, version: "prompt/workflow-modifier/v7", ...(signal ? { signal } : {}) }, agentSignal => services.providerRuntime!.generateCandidate(prompt, "prompt/workflow-modifier/v7", response => { parseWorkflowProposal(response.text); }, agentSignal,
      { traceId, sessionId, workflowId: workflow.id, actor: { id: user.id, role: user.role }, egress: { purpose: "interactive", dataClass: "restricted" } }));
  } catch {
    if (signal?.aborted) throw new HandlerFailure(409, "Workflow change request was cancelled");
    return reply("I couldn't prepare a valid change. Your saved workflow is unchanged. Please describe the change again; I will ask if a required detail is missing.", { intent: "WORKFLOW_MODIFY_ERROR", workflowId: workflow.id, toolsDispatched: false });
  }
  const result = parseWorkflowProposal(generated.text);
  if (result.kind === "clarification") return reply(result.question, { intent: "CONVERSATION", workflowId: workflow.id, needsClarification: true, toolsDispatched: false });
  const command = { type: "restoreDraft" as const, yaml: result.yaml };
  const yaml = applyWorkflowCommand(workflow.yaml, command);
  if (workflowContentHash(yaml) === workflowContentHash(workflow.yaml)) return reply("The proposed change matches the saved workflow. What would you like to change?", { intent: "CONVERSATION", workflowId: workflow.id, needsClarification: true, toolsDispatched: false });
  const validation = validateWorkspaceDraft("WorkflowProposal", yaml, user.role, services.validator, tools);
  withWorkspaceCompilationIssues(validation, generatedInputBindingIssues(parseWorkflowYAMLStrict(yaml)));
  const assistantMessage = await mutate(state => {
    const chat = assertChatAuthority(state, user, sessionId), fresh = state.workflows[workflow.id];
    if (!fresh) throw new HandlerFailure(404, "Workflow not found");
    assertCurrentWorkflowEditor(state, fresh, user); requireWorkflowBase(fresh, baseVersion, hash);
    if (services.registries.hash() !== registryHash) throw new HandlerFailure(409, "Available workflow actions changed. Request a new proposal.");
    const proposal = { id: nextID(state, "proposal"), scope: "workflow", workflowId: workflow.id, baseVersion, baseHash: hash,
      command, before: overview(workflow.yaml), after: overview(yaml), summary: result.summary, validation, status: "PROPOSED",
      modelBinding: { ...services.providerRuntime!.binding, model: generated.model } };
    const text = `I've prepared the change: ${result.summary}\n\nReview it and choose Apply to draft to save it. Nothing has been published, run or scheduled.${validation.passed ? "" : " The proposal has issues to resolve before it can run."}`;
    const message = { id: nextID(state, "msg"), role: "assistant", text, createdAt: now(), traceId,
      artifacts: { intent: "WORKFLOW_PATCH_PROPOSAL", workflowId: workflow.id, proposal, toolsDispatched: false }, modelBinding: proposal.modelBinding };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    hooks?.artifact(state, { type: "workflow-proposal", id: proposal.id });
    return message;
  });
  return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: assistantMessage.text, intent: "WORKFLOW_MODIFY" }, "Workflow change proposed; saved draft unchanged", { traceId });
}
