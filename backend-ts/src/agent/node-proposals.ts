import { toolRoleAllowed } from "../governance/tool-access.js";
import { ok } from "../models/schemas.js";
import { HandlerFailure, nextID, now, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { assertNodeContext, applyWorkflowCommand, nodeContextSchema, selectedNodePatchSchema, selectedNodePatchVersion, selectedNodePatchCommand, selectedNodePatchPreview, type NodeContext } from "../workflows/commands.js";
import { selectedConditionGuidance } from "../workflows/selected-condition-guidance.js";
import { selectedProtectedGuidance } from "../workflows/selected-protected-guidance.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { promptData } from "../prompts/contracts.js";
import type { ChatProcessingHooks } from "./chat-context.js";
import { readAuthoringContract } from "../workflows/read-authoring.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { validateWorkspaceDraft } from "../workflows/draft-validation.js";
import type { RegistrySnapshot } from "../registry/service.js";
import type { AnalysisResponse } from "../analysisprovider/types.js";
import type { ChatOperation } from "../repository/store.js";

export type PreparedNodeProposal = { context: NodeContext; scoped: ReturnType<typeof assertNodeContext>; prompt: string;
  promptTemplateVersion: string; registryHash: string; tools: RegistrySnapshot["tools"] };

export function prepareNodeProposal(scoped: ReturnType<typeof assertNodeContext>, context: NodeContext, content: string,
  snapshot: RegistrySnapshot, registryHash: string, role: string): PreparedNodeProposal {
  const structural = ["if", "return", "foreach", "protect"].includes(scoped.node.kind ?? "");
  const modelNode = ["analysis", "agent"].includes(scoped.node.kind ?? "");
  const authoring = structural || modelNode ? readAuthoringContract(parseWorkflowYAMLStrict(scoped.workflow.yaml), snapshot.tools, role, registryHash) : undefined;
  const collection = authoring?.collections?.find(node => node.nodeId === scoped.node.id);
  const prompt = promptData({ instruction: content, node: withoutSecretFields(scoped.node),
    ...(modelNode ? { allowedDataSources: authoring?.nodes.find(node => node.nodeId === scoped.node.id)?.dataSources.filter(source => source.binding.source === "nodeOutput") ?? [] } : {}),
    ...(scoped.node.kind === "if" ? selectedConditionGuidance(scoped.node.id, authoring) : {}),
    ...(scoped.node.kind === "protect" ? selectedProtectedGuidance(scoped.node.id, authoring) : {}),
    ...(scoped.node.kind === "return" ? { allowedDataSources: authoring?.returns?.find(node => node.nodeId === scoped.node.id)?.dataSources ?? [] } : {}),
    ...(scoped.node.kind === "foreach" ? { allowedItemSources: collection?.itemSources ?? [], allowedCollectSources: collection?.collectSources ?? [] } : {}),
    tools: structural ? [] : snapshot.tools.filter(tool => toolRoleAllowed(tool.allowed_roles, role)).map(tool => ({ name: tool.name, inputSchema: tool.input_schema })) });
  return { context, scoped: structuredClone(scoped), prompt, promptTemplateVersion: selectedNodePatchVersion(scoped.node), registryHash, tools: structuredClone(snapshot.tools) };
}

export function validateNodeProposalOutput(prepared: PreparedNodeProposal, output: AnalysisResponse): void {
  selectedNodePatchSchema(prepared.scoped.node).parse(JSON.parse(output.text));
}

export async function finishNodeProposal(input: { prepared: PreparedNodeProposal; currentScoped?: ReturnType<typeof assertNodeContext>; generated: AnalysisResponse; sessionId: string; traceId: string;
  user: CurrentUser; services: HandlerServices; hooks: ChatProcessingHooks; modelBinding: ChatOperation["modelBinding"] }) {
  const { prepared, generated, sessionId, traceId, user, services, hooks } = input;
  const currentScoped = input.currentScoped ?? prepared.scoped;
  const context = prepared.context;
  const patchSchema = selectedNodePatchSchema(currentScoped.node);
  const patch = patchSchema.parse(JSON.parse(generated.text));
  const command = selectedNodePatchCommand(currentScoped.node, patch);
  const yaml = applyWorkflowCommand(currentScoped.workflow.yaml, command);
  if (yaml.length > 200000) throw new HandlerFailure(422, "Proposed draft exceeds supported limits");
  const validation = validateWorkspaceDraft("NodeProposal", yaml, user.role, services.validator, services.registries.snapshot().tools);
  await hooks.beforeCommit?.();
  const result = await services.repository.mutate(state => {
    hooks.assertCurrent(state);
    const fresh = assertNodeContext(state, context, user);
    const chat = assertChatAuthority(state, user, sessionId);
    const proposal = { id: nextID(state, "proposal"), ...context, command, before: fresh.node,
      after: selectedNodePatchPreview(fresh.node, patch), validation, status: "PROPOSED", modelBinding: input.modelBinding };
    const message = { id: nextID(state, "msg"), role: "assistant", text: "Node change proposed. Review and apply it to save a new draft; nothing has been published or executed.",
      createdAt: now(), traceId, artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal } };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    hooks.artifact(state, { type: "node-proposal", id: proposal.id });
    hooks.saved(state, message);
    return { proposal, assistantMessage: message };
  });
  return ok(result, "Node change proposed; draft unchanged", { traceId });
}

/** A node edit is a proposal, never a tool request, irrespective of its prose. */
export async function processNodeProposal(input: { context: unknown; content: string; sessionId: string; traceId: string;
  user: CurrentUser; services: HandlerServices; signal?: AbortSignal; hooks: ChatProcessingHooks }) {
  const { services, user, hooks, sessionId, traceId, signal } = input;
  const context = nodeContextSchema.parse(input.context);
  const provider = services.providerRuntime;
  if (!provider?.configured) throw new HandlerFailure(503, "Configure a provider before requesting a node proposal");
  const scoped = await services.repository.read(state => {
    hooks.assertCurrent(state as import("../repository/store.js").RepositoryState);
    return assertNodeContext(state, context, user);
  });
  const prepared = prepareNodeProposal(scoped, context, input.content, services.registries.snapshot(), services.registries.hash(), user.role);
  await hooks.stage("GENERATING_NODE_PROPOSAL");
  let response: AnalysisResponse;
  try {
    response = await provider.generateCandidate(prepared.prompt, prepared.promptTemplateVersion, output => { validateNodeProposalOutput(prepared, output); }, signal,
      { traceId, workflowId: context.workflowId, sessionId, actor: { id: user.id, role: user.role }, egress: { purpose: "interactive", dataClass: "restricted" } });
  } catch { throw new HandlerFailure(422, "A supported node patch was not returned; nothing was changed", { code: "NODE_PROPOSAL_INVALID" }); }
  return finishNodeProposal({ prepared, generated: response, sessionId, traceId, user, services, hooks, modelBinding: provider.binding });
}
