import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok, fail, type Workflow } from "../../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import { inspectReadWorkflow } from "../../runner/read-workflow.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import { requestTraceId } from "../../trace/request-trace.js";
import { appendAudit, HandlerFailure, nextID, type CurrentUser, type HandlerServices } from "./common.js";
import type { RepositoryState } from "../../repository/store.js";
import { canonicalJSONBytes } from "../../core/canonical-json.js";
import { supportsReadJobs } from "../../runner/read-jobs.js";
import { promptData } from "../../prompts/contracts.js";
import { assertActorAuthority, assertChatAuthority, selectProvider } from "./model-selection.js";
import { activeChatStatus } from "../../agent/chat-jobs.js";
import { prepareCompiledExecution } from "../../workflows/read-compilation-lifecycle.js";
import { supportsCollectionReads } from "../../runner/read-collection-admission.js";
import { prepareOperationExecution, prepareOperationPublication } from "../../workflows/operation-compilation-lifecycle.js";
import { supportsOperationJobs } from "../../runner/operation-jobs.js";
import { readAuthoringContract } from "../../workflows/read-authoring.js";
import { validateWorkspaceDraft, withWorkspaceCompilationIssues } from "../../workflows/draft-validation.js";
import { savedGeneratedReturnCoverageIssues } from "../../synthesis/return-coverage.js";
import { draftHistorySummary, resolveDraftCommand, saveDraftRevision } from "../../workflows/draft-history.js";
import { boundMcpConnection, selectedMcpConnectionId } from "../../tools/mcp-dispatch-context.js";
import { effectiveStepKind } from "../../models/schemas.js";
import { hasWorkflowEffects, usesCheckpointedOperationWorkflow } from "../../workflows/execution-shape.js";
import { operationModelReadinessIssues } from "../../workflows/operation-model-readiness.js";
import { runtimeApprovalPolicyHash } from "../../runner/runtime-approvals.js";
import { selectedConditionGuidance } from "../../workflows/selected-condition-guidance.js";
import { selectedProtectedGuidance } from "../../workflows/selected-protected-guidance.js";
import { protectedOperationProfile } from "../../workflows/protected-operation-profile.js";
import { prepareProtectedOperationCompilation, assertProtectedOperationPreparationCurrent, type PreparedProtectedOperationCompilation } from "../../workflows/protected-operation-preparation.js";
import { nodeIdSchema as id, workflowRevisionSchema as base, workflowCommandSchema as command, assertNodeContext, selectedNodePatchSchema, selectedNodePatchVersion, selectedNodePatchCommand, selectedNodePatchPreview,
  permittedWorkflow as permitted, requireWorkflowBase as requireBase, assertCurrentWorkflowEditor, applyWorkflowCommand as apply } from "../../workflows/commands.js";
export { assertCurrentWorkflowEditor } from "../../workflows/commands.js";

const requestSchema = z.object({ ...base, command, proposalId: z.string().min(1).max(128).optional() }).strict();
const proposalSchema = z.object({ ...base, nodeId: id, prompt: z.string().trim().min(1).max(4000), sessionId: z.string().min(1).max(128), model: z.string().trim().min(1).max(256).optional() }).strict();

function record(workflow: Workflow) { return { workflowId: workflow.id, version: workflow.draftVersion, contentHash: workflowContentHash(workflow.yaml), yaml: workflow.yaml, publishedVersion: workflow.publishedVersion, canRun: workflow.canRun }; }
function connectionCatalog(services: HandlerServices) {
  return services.mcpConnectionRuntime?.connectionCatalog() ?? [{ id: services.config.erpbridgePrimaryConnectionId || "erpbridge-default", primary: true, dispatchSupported: true }];
}
function ownedProposal(state: RepositoryState, actorId: string, workflowId: string, proposalId: string) {
  for (const chat of Object.values(state.chats)) {
    if (chat.ownerId !== actorId) continue;
    for (const message of chat.messages) {
      const artifact = message.artifacts as { proposal?: Record<string, unknown> } | undefined;
      const item = artifact?.proposal;
      if (item?.id === proposalId && item.workflowId === workflowId) {
        if (item.status !== "PROPOSED") throw new HandlerFailure(409, "Proposal was already resolved");
        return { item, chat };
      }
    }
  }
  throw new HandlerFailure(404, "Owned proposal not found");
}

export async function handleWorkflowCommand(kind: "commands" | "node-proposals" | "readiness", request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  let draftSaveAttempted = false;
  try {
    const workflowId = String((request.params as { id: string }).id);
    const current = await services.repository.read((state) => structuredClone(state.workflows[workflowId] ?? null));
    if (current === null || !permitted(current, user, kind !== "readiness")) throw new HandlerFailure(404, "Workflow not found or not editable");
    if (current.yaml.length > 200000) throw new HandlerFailure(422, "Workflow source exceeds supported limits");
    const traceId = requestTraceId(request, current.traceId);
    if (kind === "readiness") {
      const registryHash = services.registries.hash();
      const validation = validateWorkspaceDraft("WorkspaceReadiness", current.yaml, user.role, services.validator, services.registries.snapshot().tools);
      const coverageIssues = savedGeneratedReturnCoverageIssues(current);
      if (coverageIssues.length) withWorkspaceCompilationIssues(validation, coverageIssues);
      let issues: string[] = [], bridge = "not_connected";
      let operationProfile = false;
      let protectedPreparation: PreparedProtectedOperationCompilation | undefined;
      let protectedCompilation: { state: "COMPILED_RUNTIME_PENDING"; summary: PreparedProtectedOperationCompilation } | { state: "BLOCKED"; reason: string } | undefined;
      let effectProfile: "read-only" | "contains-effects" | "unknown" = "unknown";
      try {
        const blueprint = parseWorkflowYAMLStrict(current.yaml);
        operationProfile = usesCheckpointedOperationWorkflow(blueprint, services.registries.snapshot().tools);
        effectProfile = hasWorkflowEffects(blueprint, services.registries.snapshot().tools) ? "contains-effects" : "read-only";
        if (protectedOperationProfile(blueprint) === "protected-collections-pending") {
          issues.push("Protected collection execution requires the qualified durable operation iteration worker");
          try {
            protectedPreparation = await prepareProtectedOperationCompilation(services, workflowId, user);
            protectedCompilation = { state: "COMPILED_RUNTIME_PENDING", summary: protectedPreparation };
          } catch {
            const reason = "Protected collection compilation requires current reviewed tools, connections, scoped bindings and any model or approval policies";
            protectedCompilation = { state: "BLOCKED", reason }; issues.push(reason);
          }
        } else if (operationProfile) {
          try { const prepared = await prepareOperationPublication(services, current.yaml, user); if (prepared) issues.push(...operationModelReadinessIssues(prepared.stored.plan, services.providerRuntime)); if (!supportsOperationJobs(services)) issues.push("Operation checkpoint persistence is not qualified"); }
          catch (error) { issues.push(error instanceof HandlerFailure && error.meta !== null && typeof error.meta === "object" && "code" in error.meta && error.meta.code === "PROTECTED_COLLECTION_RUNTIME_PENDING" ? error.message : "Operation requires a supported reviewed artifact and current connection"); }
        } else issues = inspectReadWorkflow(blueprint, services.registries.snapshot().tools, user.role, supportsCollectionReads(services));
        const connectionIds = [...new Set(blueprint.steps.filter(step => effectiveStepKind(step) !== "analysis").map(step => selectedMcpConnectionId(services, step.connection_id)))];
        if (connectionIds.length) {
          let selectedConnections;
          try { selectedConnections = connectionIds.map(id => boundMcpConnection(services, id)); }
          catch { selectedConnections = null; }
          if (selectedConnections) try {
            const liveByConnection = new Map(await Promise.all(selectedConnections.map(async value => [value.id, await discoverTools(value.session, services.registries)] as const)));
            bridge = "discovery_available";
            if (!operationProfile) {
              const live = [...new Map([...liveByConnection.values()].flatMap(items => items.map(tool => [tool.tool_id, tool] as const))).values()];
              issues.push(...inspectReadWorkflow(blueprint, live, user.role, supportsCollectionReads(services)));
              for (const step of blueprint.steps) if ((liveByConnection.get(selectedMcpConnectionId(services, step.connection_id)) ?? []).filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action).length !== 1)
                issues.push(`Node ${step.id} is unavailable on its selected ERPBridge connection`);
            }
          } catch { bridge = "discovery_failed"; }
        }
      } catch { issues.push("Workflow could not be parsed"); }
      let approvalSetupRequired = false;
      if (effectProfile === "contains-effects") {
        try { await services.repository.readAuthoritative(state => runtimeApprovalPolicyHash(state, user.id)); }
        catch (error) {
          if (!(error instanceof HandlerFailure) || !error.meta || typeof error.meta !== "object" || !("code" in error.meta) || error.meta.code !== "RUNTIME_APPROVAL_DENIED") throw error;
          approvalSetupRequired = true; issues.push("Transaction reviewers are not configured or enabled. An administrator must configure independent approval in Settings before this workflow can run.");
        }
      }
      const published = await services.repository.read((state) => (state.versions[workflowId] ?? []).some((version) => version.artifactState === "PUBLISHED" && version.version === current.publishedVersion && version.yaml === current.yaml));
      const compilation = await services.repository.readAuthoritative(state => {
        const version = (state.versions[workflowId] ?? []).findLast(value => value.artifactState === "PUBLISHED" && value.version === current.publishedVersion && value.yaml === current.yaml);
        if (!version) return { state: "NOT_PUBLISHED" };
        try { return { state: "CURRENT", receipt: operationProfile ? prepareOperationExecution(state, services, version, current.yaml, user.role).receipt : prepareCompiledExecution(state, services, version, current.yaml, user.role).receipt }; }
        catch { return { state: "BLOCKED", reason: "Review and explicitly republish current capability bindings" }; }
      });
      if (compilation.state === "BLOCKED") issues.push("Published execution artifact needs current capability review and explicit re-publication");
      const canAttempt = user.permissions.some((permission) => ["workflow:run", "workflow:run_own"].includes(permission)) &&
        (user.permissions.includes("workflow:run") || current.owner.id === user.id || (current.assignedUserIds ?? []).includes(user.id));
      const workspace = await services.repository.readAuthoritative(state => {
        assertActorAuthority(state, user);
        const fresh = state.workflows[workflowId];
        if (!fresh || !permitted(fresh, user, false)) throw new HandlerFailure(404, "Workflow not found");
        requireBase(fresh, current.draftVersion, workflowContentHash(current.yaml));
        if (registryHash !== services.registries.hash()) throw new HandlerFailure(409, "Registry changed during readiness. Reload before continuing", { code: "READINESS_CONTEXT_CHANGED" });
        if (protectedPreparation) assertProtectedOperationPreparationCurrent(protectedPreparation, services, state, user);
        let blueprint;
        try { blueprint = parseWorkflowYAMLStrict(current.yaml); }
        catch { return { authoring: { profile: "read-authoring/v1", registryHash: services.registries.hash(), nodes: [], reason: "Workflow source cannot be parsed; existing values are preserved" }, editHistory: draftHistorySummary(state, fresh) }; }
        return { authoring: readAuthoringContract(blueprint, services.registries.snapshot().tools, user.role, services.registries.hash(), connectionCatalog(services)), editHistory: draftHistorySummary(state, fresh) };
      });
      const { authoring, editHistory } = workspace;
      if ("protectedIssues" in authoring && Array.isArray(authoring.protectedIssues)) issues.push(...authoring.protectedIssues);
      const protectedRuntimePending = "executionProfile" in authoring && authoring.executionProfile === "protected-draft-runtime-pending";
      return reply.send(ok({ ...record(current), validation, issues: [...new Set(issues)], bridge, published, compilation, authoring,
        editHistory, effectProfile, ...(protectedCompilation ? { protectedCompilation } : {}),
        can_attempt_run: canAttempt && published && compilation.state === "CURRENT" && validation.passed && !issues.length && bridge === "discovery_available" && !current.pendingGenerationApproval?.steps.length,
        read_job_admission: supportsReadJobs(services) ? "read-job-v1" : "unavailable",
        read_snapshot_schedule_admission: supportsReadJobs(services) && published && compilation.state === "CURRENT" && !operationProfile &&
          effectProfile === "read-only" && "receipt" in compilation && compilation.receipt?.schemaVersion !== "workflow-read-ir/v4" && validation.passed ? "read-snapshot/v1" : "unavailable",
        operation_job_admission: !protectedRuntimePending && operationProfile && supportsOperationJobs(services) ? "operation-job/v1" : "unavailable",
        approval_setup_required: approvalSetupRequired, can_manage_approval_policy: user.role === "Platform Admin" && user.permissions.includes("settings:manage"),
        authorization: "rechecked_at_dispatch", executionProfile: protectedRuntimePending ? "protected-draft-runtime-pending" : "executionProfile" in authoring && authoring.executionProfile === "protected-operation-v1" ? "protected-operation-v1" : operationProfile ? "sequential-operation-v1" : "receipt" in compilation && compilation.receipt?.schemaVersion === "workflow-read-ir/v4" ? "collection-read-v1" : "executionProfile" in authoring ? authoring.executionProfile : "sequential-read-v1" }, "Readiness checked", { traceId }));
    }
    if (kind === "node-proposals") {
      const parsed = proposalSchema.safeParse(request.body);
      if (!parsed.success) throw new HandlerFailure(400, "Invalid node proposal request");
      const value = parsed.data;
      requireBase(current, value.baseVersion, value.baseHash);
      const { node } = await services.repository.read(state => assertNodeContext(state, { workflowId, nodeId: value.nodeId, baseVersion: value.baseVersion, baseHash: value.baseHash }, user));
      if (!(await services.repository.read((state) => state.chats[value.sessionId]?.ownerId === user.id))) throw new HandlerFailure(404, "Chat session not found");
      if (!services.providerRuntime?.configured) throw new HandlerFailure(503, "Configure a model provider before requesting a node proposal", { code: "PROVIDER_NOT_CONFIGURED" });
      const sessionModel = await services.repository.read((state) => {
        if (Object.values(state.chatOperations).some(op => op.sessionId === value.sessionId && activeChatStatus(op.status))) throw new HandlerFailure(409, "This conversation has an active operation", { code: "CHAT_OPERATION_ACTIVE" });
        return assertChatAuthority(state, user, value.sessionId).selectedModel;
      });
      const provider = selectProvider(services, value.model ?? sessionModel)!;
      const structural = ["if", "return", "foreach", "protect"].includes(node.kind ?? "");
      const authoring = structural ? readAuthoringContract(parseWorkflowYAMLStrict(current.yaml), services.registries.snapshot().tools, user.role, services.registries.hash(), connectionCatalog(services)) : undefined;
      const collection = authoring?.collections?.find(value => value.nodeId === node.id);
      const availableTools = services.registries.snapshot().tools.filter((tool) => tool.allowed_roles.includes(user.role));
      const promptTools = node.kind === "agent" ? availableTools.filter(tool => tool.is_read_only && (node.allowed_actions ?? []).some(action => action === tool.name || action === tool.mcp_tool_name)) : availableTools;
      const prompt = promptData({ instruction: value.prompt, node: withoutSecretFields(node),
        ...(node.kind === "if" ? selectedConditionGuidance(node.id, authoring) : {}),
        ...(node.kind === "protect" ? selectedProtectedGuidance(node.id, authoring) : {}),
        ...(node.kind === "return" ? { allowedDataSources: authoring?.returns?.find(value => value.nodeId === node.id)?.dataSources ?? [] } : {}),
        ...(node.kind === "foreach" ? { allowedItemSources: collection?.itemSources ?? [], allowedCollectSources: collection?.collectSources ?? [] } : {}),
        tools: structural ? [] : promptTools.map((tool) => ({ name: tool.name, inputSchema: tool.input_schema, readOnly: tool.is_read_only })) });
      const patch = selectedNodePatchSchema(node);
      let proposed: ReturnType<typeof patch.parse>;
      try {
        const response = await provider.generateCandidate(prompt, selectedNodePatchVersion(node), (output) => { patch.parse(JSON.parse(output.text)); }, request.signal,
          { traceId, workflowId, ...(value.sessionId ? { sessionId: value.sessionId } : {}), actor: { id: user.id, role: user.role }, egress: { purpose: "interactive", dataClass: "restricted" } });
        proposed = patch.parse(JSON.parse(response.text));
      } catch { throw new HandlerFailure(422, "The model did not return a supported node patch; nothing was changed", { code: "NODE_PROPOSAL_INVALID" }); }
      const change = selectedNodePatchCommand(node, proposed);
      const yaml = apply(current.yaml, change);
      const validation = validateWorkspaceDraft("NodeProposal", yaml, user.role, services.validator, services.registries.snapshot().tools);
      const proposal = await services.repository.mutate((state) => {
        if (Object.values(state.chatOperations).some(op => op.sessionId === value.sessionId && activeChatStatus(op.status))) throw new HandlerFailure(409, "This conversation has an active operation", { code: "CHAT_OPERATION_ACTIVE" });
        const scopedChat = assertChatAuthority(state, user, value.sessionId);
        if (provider.binding) scopedChat.selectedModel = provider.binding.model;
        const fresh = state.workflows[workflowId];
        if (!fresh || !permitted(fresh, user, true)) throw new HandlerFailure(404, "Workflow not editable");
        assertCurrentWorkflowEditor(state, fresh, user);
        requireBase(fresh, value.baseVersion, value.baseHash);
        const result = { id: nextID(state, "proposal"), workflowId, nodeId: node.id, baseVersion: value.baseVersion, baseHash: value.baseHash, command: change, before: node, after: selectedNodePatchPreview(node, proposed), validation, status: "PROPOSED", modelBinding: provider.binding };
        if (value.sessionId) {
          const chat = state.chats[value.sessionId];
          if (!chat || chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat session not found");
          chat.messages.push({ id: nextID(state, "msg"), role: "user", text: value.prompt, createdAt: new Date().toISOString(), traceId, artifacts: { intent: "NODE_EDIT_REQUEST", workflowId, nodeId: node.id } },
            { id: nextID(state, "msg"), role: "assistant", text: "Node change proposed. Review and apply it to save a new draft; nothing has been published or executed.", createdAt: new Date().toISOString(), traceId, artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal: result } });
          chat.messageCount = chat.messages.length; chat.updatedAt = new Date().toISOString();
        }
        return result;
      });
      return reply.send(ok(proposal, "Node change proposed; draft unchanged", { traceId }));
    }
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) throw new HandlerFailure(400, "Invalid workflow command");
    requireBase(current, parsed.data.baseVersion, parsed.data.baseHash);
    const yaml = await services.repository.readAuthoritative(state => {
      const fresh = state.workflows[workflowId];
      if (!fresh) throw new HandlerFailure(404, "Workflow not editable");
      assertCurrentWorkflowEditor(state, fresh, user); requireBase(fresh, parsed.data.baseVersion, parsed.data.baseHash);
      return resolveDraftCommand(state, fresh, parsed.data.command);
    });
    if (yaml.length > 200000) throw new HandlerFailure(422, "Resulting draft exceeds supported limits");
    const validation = validateWorkspaceDraft("WorkflowCommand", yaml, user.role, services.validator, services.registries.snapshot().tools);
    draftSaveAttempted = parsed.data.command.type !== "discardProposal";
    const saved = await services.repository.mutate((state) => {
      const fresh = state.workflows[workflowId];
      if (!fresh || !permitted(fresh, user, true)) throw new HandlerFailure(404, "Workflow not editable");
      const editor = assertCurrentWorkflowEditor(state, fresh, user);
      requireBase(fresh, parsed.data.baseVersion, parsed.data.baseHash);
      if (parsed.data.command.type === "discardProposal") {
        const { item, chat } = ownedProposal(state, user.id, workflowId, parsed.data.command.proposalId);
        item.status = "DISCARDED"; item.resolvedAt = new Date().toISOString(); item.resolvedBy = user.id;
        chat.updatedAt = String(item.resolvedAt);
        appendAudit(state, editor, "workflow.proposal.discard", "workflow", workflowId, {}, { proposalId: item.id }, request);
        return { workflow: structuredClone(fresh), editHistory: draftHistorySummary(state, fresh) };
      }
      if (parsed.data.proposalId) {
        const { item, chat } = ownedProposal(state, user.id, workflowId, parsed.data.proposalId);
        if (item.baseHash !== parsed.data.baseHash || item.baseVersion !== parsed.data.baseVersion ||
            !canonicalJSONBytes(item.command).equals(canonicalJSONBytes(parsed.data.command)))
          throw new HandlerFailure(409, "Applied command does not match the saved proposal");
        item.status = "APPLIED"; item.appliedVersion = fresh.draftVersion + 1;
        item.resolvedAt = new Date().toISOString(); item.resolvedBy = user.id; chat.updatedAt = String(item.resolvedAt);
      }
      const beforeHash = workflowContentHash(fresh.yaml);
      saveDraftRevision(state, fresh, yaml, parsed.data.command, editor, validation.passed);
      appendAudit(state, editor, "workflow.command", "workflow", workflowId, { contentHash: beforeHash }, { contentHash: workflowContentHash(yaml), command: parsed.data.command.type, version: fresh.draftVersion, ...(parsed.data.proposalId ? { proposalId: parsed.data.proposalId } : {}) }, request);
      return { workflow: structuredClone(fresh), editHistory: draftHistorySummary(state, fresh) };
    });
    const { workflow: updated, editHistory } = saved;
    return reply.send(ok({ ...record(updated), validation, editHistory }, parsed.data.command.type === "discardProposal" ? "Proposal discarded; draft unchanged" : "Draft saved; not published or executed", { traceId }));
  } catch (error) {
    if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
    if (draftSaveAttempted) return reply.status(503).send(fail("Draft save outcome is unconfirmed. Reload authoritative storage before another edit; no automatic retry was sent", { code: "DRAFT_SAVE_UNCONFIRMED" }));
    try { services.repository.assertAuthority(); }
    catch { return reply.status(503).send(fail("Authoritative workflow storage is unavailable. Refresh saved history before another edit", { code: "WORKFLOW_STORAGE_UNAVAILABLE" })); }
    return reply.status(422).send(fail("Workflow command could not be parsed; nothing was changed", null));
  }
}
