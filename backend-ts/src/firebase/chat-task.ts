import { createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { withFunctionResources, withFunctionRuntime as baseFunctionRuntime, type FunctionComposition } from "./invocation.js";
import { withUserMcpBinding } from "../tools/user-mcp-credentials.js";
import { functionStatePhases } from "./state-phases.js";
import { chatJobQueue, decodePrivateChatInput, appendChatOperationAudit as audit, appendChatOperationEvent as event,
  reconcileChatOperation, chatTaskReceipt, activeChatStatus } from "../agent/chat-jobs.js";
import { chatTaskCommandSchema, assertChatTaskOutbox, chatTaskLeaseSchema, type ChatTaskCommand } from "../agent/chat-task-outbox.js";
import { authorizeChatOperation } from "../agent/chat-progress.js";
import { classifyIntent } from "../agent/intent-classifier.js";
import { firebaseChatTaskDeadlineMs } from "./chat-task-deadline.js";
import { queryChatHistory, queryChatPresentation } from "../agent/query-chat-presentation.js";
import { runQueryLoop } from "../agent/query-loop.js";
import { chatWorkspaceStatus, workspaceStatusAnswer } from "../agent/chat-workspace-status.js";
import { prepareChatPolicyRequest, assertChatPolicyContext } from "../governance/chat-policy.js";
import { prepareOptionalPolicy, interpretLocalPolicy, finalOptionalPolicy, appendOptionalPolicyAudit, assertLocalPolicyCurrent, policySwitches } from "../governance/optional-policy.js";
import { operationGovernanceBinding } from "../governance/service.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { bindPhasedReadPolicy, dispatchReadTool, observedReadPolicyFailure } from "../tools/read-tool-broker.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { OpenAICompatibleClient, isQueryFallbackEligible, OpenAICompatibleError, generationRequestBody } from "../providers/openai-compatible.js";
import { assertToolQueryPromptContract, configuredModels } from "../providers/runtime.js";
import { assertModelEgress, normalizeModelEgressPolicy } from "../providers/egress-policy.js";
import { latestContinuationModel, providerWireMessages } from "../analysisprovider/provider-continuation.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { generationMessages, generationPromptHash } from "../prompts/contracts.js";
import { CANDIDATE_PROMPT_VERSION } from "../providers/runtime.js";
import type { AnalysisResponse, ProviderInvocationContext } from "../analysisprovider/types.js";
import { type SynthesisInput, type PreparedCandidate } from "../synthesis/service.js";
import { prepareNodeProposal, validateNodeProposalOutput, finishNodeProposal, type PreparedNodeProposal } from "../agent/node-proposals.js";
import { nodeContextSchema, assertNodeContext } from "../workflows/commands.js";
import { recurringDeliveryRequest } from "../delivery/recurring-automation.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { boundedOperation } from "../core/bounded-operation.js";
import type { OwnedJSONRequest } from "../core/bounded-json-request.js";
import { AESGCMCodec, decodeEncryptionKey } from "../storage/aes-gcm.js";
import { storeChatModelContent } from "../storage/chat-model-content.js";
import { openFirestoreChatCancellation } from "../storage/firestore-chat-cancellation.js";
import { restoreImportedCapabilities } from "../registry/capability-import.js";
import { assertChatAuthority, withSelectedProvider } from "../http/handlers/model-selection.js";
import { isRecord, stringValue, type HandlerServices } from "../http/handlers/common.js";
import { processStoredChat } from "../http/handlers/chat.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { reviewedModelSourceContext } from "../synthesis/reviewed-model-sources.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { nextID, now } from "../http/handlers/common.js";
import type { ChatOperation, ChatAttempt, ChatModelAttempt, RepositoryState } from "../repository/store.js";
import type { QueryMessage, QueryOptions, QueryToolDefinition, QueryTurnResult } from "../analysisprovider/query-types.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
const durableBinding = (state: Readonly<RepositoryState>) => digest([state.providers, state.mcpConnections,
  operationGovernanceBinding(state.governancePolicy).authority, state.settings.llm, state.settings.rbac]);
const operationBinding = (op: ChatOperation) => digest([op.id, op.sessionId, op.actorId, op.userMessageId, op.requestFingerprint,
  op.connectionFingerprint, op.contractFingerprint, op.authorityFingerprint, op.modelBinding, op.taskDispatchSecret]);
type ReadPolicyStop = { error: unknown; reason: string; binding: string; operationBinding: string; attempt: ChatAttempt };
const policyStopJournalMatches = (state: Readonly<RepositoryState>, op: ChatOperation, attemptId: string) => {
  const journal = state.chatOperationEvents[op.id] ?? [], entries = journal.filter(entry => entry.attemptId === attemptId);
  return journal.length === op.lastSequence && journal.every((entry, index) => entry.version === 1 && entry.sequence === index + 1 && entry.operationId === op.id && entry.sessionId === op.sessionId) &&
    entries.length === 2 && entries[0]!.type === "tool.preparing" && entries[0]!.stage === "VERIFYING" && entries[0]!.status === "RUNNING" &&
    entries[1]!.type === "tool.failed" && entries[1]!.stage === "READ_STOPPED" && entries[1]!.status === "RUNNING";
};
const policyStopReason = (receipt: Record<string, unknown>) => {
  if (receipt.failureCode === "POLICY_CHECK_CANCELLED") return undefined;
  if (["LOCAL_POLICY_CONFIG_INVALID", "LOCAL_POLICY_PROVIDER_FAILED", "LOCAL_POLICY_RESPONSE_INVALID"].includes(String(receipt.failureCode))) return String(receipt.failureCode);
  if (receipt.failureCode !== undefined) return undefined;
  return receipt.decision === "review" ? "POLICY_REVIEW_REQUIRED" : receipt.decision === "deny" ? "POLICY_DENIED" : receipt.decision === "unavailable" ? "POLICY_UNAVAILABLE" : undefined;
};

/** Functions QUERY/AUDIT coordinator. Concrete runtime/validators stay inside
 * owned phases. Only detached input, pure loop state and pending transport
 * handles survive a close. Other intents retain their existing execution path. */
export async function executeFunctionChatTask(composition: FunctionComposition, raw: ChatTaskCommand,
  options: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: firebaseChatTaskDeadlineMs(composition.config.functionsChatTaskTimeoutMs) }) {
  const command = chatTaskCommandSchema.parse(raw), phases = functionStatePhases(composition);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10 || options.timeoutMs > 240_000) throw new Error("Invalid bounded chat task deadline");
  const candidate = await phases.read(state => {
    const op = state.chatOperations[command.operationId];
    if (!op || assertChatTaskOutbox(op).taskId !== command.taskId || op.taskDispatchSecret!.state === "PREPARED") throw new Error("Chat task has no acknowledged original enqueue intention");
    if (!activeChatStatus(op.status)) return { terminal: chatTaskReceipt(state, command) };
    if (op.status === "RUNNING") return { running: true };
    const input = decodePrivateChatInput(op, composition.config.storageEncryptionKey);
    return { input, credentialBinding: op.erpCredentialSecret, intent: classifyIntent(input.content, { workflowContext: input.body.workflowContext !== undefined || input.body.nodeContext !== undefined, nodeContext: input.body.nodeContext !== undefined }) };
  });
  if ("terminal" in candidate) return candidate.terminal;
  if ("running" in candidate) return phases.mutate(state => {
    const op = state.chatOperations[command.operationId]!, lease = chatTaskLeaseSchema.parse(op.taskLeaseSecret);
    if (op.status !== "RUNNING" || lease.workerId !== op.workerId || lease.epoch !== op.epoch || Date.parse(lease.expiresAt) <= Date.parse(lease.claimedAt) || Date.now() < Date.parse(lease.expiresAt))
      throw new Error("Original chat claim is still live or inconsistent; retry original delivery");
    reconcileChatOperation(state, op, "CHAT_TASK_INTERRUPTED"); return chatTaskReceipt(state, command);
  });
  const input = candidate.input!;
  const withFunctionRuntime: typeof baseFunctionRuntime = (c, action) => baseFunctionRuntime({ ...c, ...(c.config.pipelineAPIBaseURL && c.config.pipelineAPIKey ? { runtimePurpose: "document-services" as const } : {}) }, runtime =>
    withUserMcpBinding(runtime.services, input.user.id, candidate.credentialBinding, () => action(runtime)));
  // Agent-led routing must happen before any heuristic-specific branch. Use
  // the existing bounded queued worker; legacy pattern mode retains phased
  // query/synthesis dispatch. Do not silently bypass semantic routing here.
  // Reviewed document resolution belongs to the shared owned worker. The
  // legacy phased synthesis path has no document-source/version admission.
  if (composition.config.chatIntentRouting === "agent" || composition.config.pipelineAPIBaseURL && composition.config.pipelineAPIKey || input.body.documentContext !== undefined || input.body.attachmentTicket !== undefined)
    return withFunctionRuntime(composition, async ({ services }) => chatJobQueue(services).executeTask(command, options));
  const nodeProposalRequest = input.body.nodeContext !== undefined && !["WORKFLOW_DISCUSSION", "CONVERSATION"].includes(candidate.intent!);
  const synthesisRequest = !nodeProposalRequest && candidate.intent === "ACTION" && recurringDeliveryRequest(input.content) === null;
  if (!(["QUERY", "AUDIT"].includes(candidate.intent!) || nodeProposalRequest || synthesisRequest) || !input.provider)
    return withFunctionRuntime(composition, async ({ services }) => chatJobQueue(services).executeTask(command, options));

  const workerId = `chat-phase-worker-${randomBytes(12).toString("hex")}`, deadlineAt = Date.now() + options.timeoutMs;
  const controller = new AbortController(), timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal, timeoutSignal]) : AbortSignal.any([controller.signal, timeoutSignal]);
  const control = openFirestoreChatCancellation(composition.config), observing = new AbortController();
  // Intentional internal task shutdown must not abandon an entered stop read.
  // Only genuine external cancellation/deadline can fence that shared reader.
  const observationSignal = AbortSignal.any([timeoutSignal, ...(options.signal ? [options.signal] : []), ...(composition.signal ? [composition.signal] : [])]);
  const transports = new Map<OwnedJSONRequest, "PENDING" | "CONFIRMED" | "UNCONFIRMED">(), codec = new AESGCMCodec(composition.config.storageEncryptionKey);
  let admitted: ChatOperation | undefined, watch: Promise<void> | undefined, ordinal = 0, stopRequested = false, reconciliationRequired = false,
    cleanupDeadline: number | undefined, controlClosed = false, finalizationUnconfirmed = false, cleanPolicyStop: ReadPolicyStop | undefined;
  const ownRequest = (request: OwnedJSONRequest) => {
    transports.set(request, "PENDING");
    void request.settled.then(() => transports.set(request, "CONFIRMED"), () => transports.set(request, "UNCONFIRMED"));
  };
  const drain = async (requests: readonly OwnedJSONRequest[], abort = false) => {
    if (abort) for (const request of requests) request.abort();
    if (requests.some(request => transports.get(request) === "PENDING")) {
      cleanupDeadline ??= Date.now() + 1000;
      const remaining = cleanupDeadline - Date.now();
      if (remaining <= 0) return false;
      try { await boundedOperation(() => Promise.allSettled(requests.map(request => request.settled)), { timeoutMs: remaining, label: "Chat model transport disposal" }); }
      catch { return false; }
    }
    return requests.every(request => transports.get(request) === "CONFIRMED");
  };
  const fingerprint = (value: unknown) => createHmac("sha256", decodeEncryptionKey(composition.config.storageEncryptionKey)).update(canonicalJSONBytes(value)).digest("hex");
  const current = (state: Readonly<RepositoryState>) => {
    const op = state.chatOperations[command.operationId];
    if (!admitted || !op || op.status !== "RUNNING" || op.workerId !== workerId || op.epoch !== admitted.epoch || signal.aborted || op.cancellationRequested)
      throw new Error("Original chat phase is no longer authorized");
    const lease = chatTaskLeaseSchema.parse(op.taskLeaseSecret);
    if (assertChatTaskOutbox(op).taskId !== command.taskId || lease.workerId !== workerId || lease.epoch !== op.epoch || lease.expiresAt !== new Date(deadlineAt).toISOString() || Date.now() >= deadlineAt)
      throw new Error("Original chat phase claim changed or expired");
    authorizeChatOperation(state, op, input.user); return op;
  };
  const observeStop = async () => {
    if (!admitted) return false;
    if (await control.requested(admitted, observationSignal)) {
      stopRequested = true;
      controller.abort(); return true;
    }
    return false;
  };
  const synchronize = async () => {
    if (await observeStop()) throw new Error("Original chat was cancelled");
    if (signal.aborted) throw new Error("Original chat phase cancelled or expired");
  };
  try {
    admitted = await phases.mutate(state => {
      const op = state.chatOperations[command.operationId];
      if (!op || op.status !== "QUEUED" || assertChatTaskOutbox(op).taskId !== command.taskId || signal.aborted) throw new Error("Original chat claim is no longer available");
      authorizeChatOperation(state, op, input.user);
      op.status = "RUNNING"; op.stage = "PREPARING"; op.workerId = workerId; op.epoch++;
      op.taskLeaseSecret = { profile: "chat-task-lease/v1", workerId, epoch: op.epoch, claimedAt: now(), expiresAt: new Date(deadlineAt).toISOString() };
      event(state, op, "operation.started"); audit(state, op, "chat.operation.claimed"); return op;
    });
    watch = (async () => {
      try {
        while (!observing.signal.aborted) {
          try { await pause(250, undefined, { signal: observing.signal }); }
          catch (error) { if (observing.signal.aborted) return; throw error; }
          if (observing.signal.aborted || signal.aborted) return;
          if (await observeStop()) return;
          if (signal.aborted) return;
        }
      } catch {
        // A failed entered read remains uncertainty even if orderly shutdown
        // was requested concurrently or another read proved a genuine Stop.
        // Proved Stop is a normal boolean result, never classified by this catch.
        reconciliationRequired = true;
        controller.abort();
      }
    })();
    const policyInput = { prompt: input.content, intent: candidate.intent!, nodeContext: input.body.nodeContext,
      traceId: admitted.traceId, sessionId: admitted.sessionId, signal };
    const validatePolicyRuntime = async (services: HandlerServices, expectedBinding?: string) => {
      await synchronize();
      await services.repository.readAuthoritative(state => current(state));
      if (fingerprint({ binding: services.mcpConnectionRuntime?.admissionConfigurationBinding ?? services.erpbridgeSession?.admissionBinding ?? null, roles: services.config.erpbridgeRoleMap }) !== admitted!.connectionFingerprint ||
          fingerprint(services.registries.snapshot().tools) !== admitted!.contractFingerprint) throw new Error("Original chat connection or contracts changed");
      const configuration = services.providerRuntime?.snapshot(input.provider!.model).configuration;
      if (!configuration || fingerprint(configuration) !== fingerprint(input.provider)) throw new Error("Original provider configuration changed");
      return services.repository.readAuthoritative(state => {
        current(state); const binding = durableBinding(state);
        if (expectedBinding !== undefined && binding !== expectedBinding) throw new Error("Original policy binding changed during preflight");
        return binding;
      });
    };
    const policyRequests: OwnedJSONRequest[] = [];
    // Only detached data and an already-entered pending transport cross this
    // scope. Local inference never retains the setup namespace writer.
    const preflight = await withFunctionRuntime(composition, async ({ services }) => {
      const binding = await validatePolicyRuntime(services);
      const request = await prepareChatPolicyRequest(services, input.user, policyInput);
      const { signal: _requestSignal, ...detachedRequest } = request;
      const selected = await prepareOptionalPolicy(services, input.user, request);
      await validatePolicyRuntime(services, binding);
      const latest = await prepareChatPolicyRequest(services, input.user, policyInput);
      if (digest(latest.context) !== digest(request.context)) throw new Error("Original policy node context changed before entry");
      if (selected.kind === "decision") {
        const policy = await services.repository.mutate(state => {
          current(state); if (durableBinding(state) !== binding) throw new Error("Original policy binding changed before decision");
          assertChatPolicyContext(state, input.user, detachedRequest);
          const decision = finalOptionalPolicy(state, input.user, selected.settings, { ...selected.decision, ...(selected.fallbackUsed ? { fallbackUsed: true } : {}) }, signal.aborted);
          appendOptionalPolicyAudit(state, input.user, decision, detachedRequest); return decision;
        });
        return { kind: "decision" as const, policy, binding, request: detachedRequest };
      }
      const plan = selected.plan, configuration = input.provider!, model = configuration.model;
      assertModelEgress(normalizeModelEgressPolicy(configuration.egressPolicy, configuration.baseURL), configuration.baseURL, plan.context.egress!);
      await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, plan);
      const requestHash = digest({ prompt: plan.prompt, context: plan.context, model, policy: plan.metadata, node: request.context });
      const wireHash = digest(generationRequestBody(configuration.baseURL, model, configuration.temperature, plan.prompt, plan.context));
      const id = `chatmodel_${digest([command.taskId, workerId, admitted!.epoch, ++ordinal, requestHash])}`, started = performance.now();
      const attempt: ChatModelAttempt = { id, taskId: command.taskId, workerId, epoch: admitted!.epoch, expiresAt: new Date(deadlineAt).toISOString(), ordinal,
        requestHash, configurationFingerprint: fingerprint(configuration), configurationRevision: admitted!.modelBinding!.configurationRevision,
        model, promptTemplateVersion: "prompt/local-policy/v2", egress: plan.context.egress!, status: "DISPATCH_INTENT", startedAt: now(), provenanceId: `inv_${id}`, purpose: "POLICY_PREFLIGHT" };
      await services.repository.mutate(state => {
        const op = current(state); if (durableBinding(state) !== binding || (op.modelAttemptsSecret?.length ?? 0) >= 32 ||
            op.modelAttemptsSecret?.some(item => ["DISPATCH_INTENT", "UNKNOWN"].includes(item.status))) throw new Error("Original local policy intent is unavailable");
        assertChatPolicyContext(state, input.user, detachedRequest);
        (op.modelAttemptsSecret ??= []).push(attempt); event(state, op, "model.dispatch_intent", id);
      });
      // Lost intent ACK never reaches dispatch. Recheck observed file/context
      // after that ACK and immediately before the single-use transport entry.
      await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, plan);
      const beforeEntry = await prepareChatPolicyRequest(services, input.user, policyInput);
      if (digest(beforeEntry.context) !== digest(request.context)) throw new Error("Original policy node context changed before dispatch");
      await validatePolicyRuntime(services, binding);
      const transport = services.providerRuntime!.fetchImplementation ?? fetch, repository = services.repository;
      let entered = false, unused = true;
      const send: typeof fetch = (url, init) => {
        repository.assertAuthority();
        if (!unused || signal.aborted || Date.now() >= deadlineAt) throw new Error("Exact policy dispatch was fenced or consumed");
        unused = false;
        if (String(url) !== `${configuration.baseURL.trim().replace(/\/+$/, "")}/chat/completions` || init?.method !== "POST" || digest(JSON.parse(String(init.body))) !== wireHash)
          throw new Error("Exact acknowledged policy request does not match transport entry");
        entered = true; return transport(url, init);
      };
      const client = new OpenAICompatibleClient({ ...configuration, fetchImplementation: send, ownRequest: owned => { ownRequest(owned); policyRequests.push(owned); } });
      const pending = client.generate(plan.prompt, model, signal, plan.context); void pending.catch(() => {});
      if (!entered) throw new Error("Exact policy transport did not enter while writer was owned");
      return { kind: "local" as const, binding, request: detachedRequest, selected, attempt, pending, started };
    }).catch(async error => { reconciliationRequired = true; controller.abort(); await drain(policyRequests, true); throw error; });
    let policy;
    if (preflight.kind === "decision") policy = preflight.policy;
    else {
      let response: AnalysisResponse | undefined, failure: unknown;
      try { response = await preflight.pending; } catch (error) { failure = error; }
      if (!await drain(policyRequests, failure !== undefined)) { reconciliationRequired = true; controller.abort(); throw new Error("Original policy transport disposal is unconfirmed"); }
      const uncertain = failure !== undefined && (!(failure instanceof OpenAICompatibleError) || ["timeout", "transport", "cancelled"].includes(failure.kind));
      const decision = interpretLocalPolicy(preflight.selected.plan, response, failure, signal.aborted);
      policy = await withFunctionRuntime(composition, async ({ services }) => {
        await validatePolicyRuntime(services, preflight.binding);
        await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, preflight.selected.plan);
        const request = await prepareChatPolicyRequest(services, input.user, policyInput);
        if (digest(request.context) !== digest(preflight.request.context)) throw new Error("Original policy node context changed during inference");
        return services.repository.mutate(state => {
          const op = current(state);
          if (durableBinding(state) !== preflight.binding) throw new Error("Original policy binding changed before result");
          assertChatPolicyContext(state, input.user, preflight.request);
          const original = op.modelAttemptsSecret?.find(item => item.id === preflight.attempt.id);
          if (!original || digest(original) !== digest(preflight.attempt) || original.status !== "DISPATCH_INTENT" ||
              op.modelAttemptsSecret?.some(item => item.id !== original.id && ["DISPATCH_INTENT", "UNKNOWN"].includes(item.status)))
            throw new Error("Original policy result intention changed");
          const bytes = response ? Buffer.from(JSON.stringify(response)) : undefined;
          storeChatModelContent(op.modelAttemptsSecret??[],original,bytes,composition.config.firestoreContentFormat==="native-fields/v1",codec);
          original.status = response ? "DONE" : uncertain ? "UNKNOWN" : "FAILED"; original.completedAt = now();
          state.invocationProvenance[original.provenanceId] = { id: original.provenanceId,
            promptSha256: generationPromptHash(preflight.selected.plan.prompt, original.promptTemplateVersion), provider: input.provider!.type, providerId: input.provider!.id,
            configurationRevision: original.configurationRevision, model: original.model, inputTokens: response?.inputTokens ?? 0, outputTokens: response?.outputTokens ?? 0,
            measured: response?.measured === true, latencyMs: Math.max(0, performance.now() - preflight.started), temperature: input.provider!.temperature,
            fallbackUsed: preflight.selected.fallbackUsed, status: response ? "SUCCEEDED" : "FAILED", createdAt: now(), ...preflight.selected.plan.context };
          const final = finalOptionalPolicy(state, input.user, preflight.selected.settings, { ...decision, ...(preflight.selected.fallbackUsed ? { fallbackUsed: true } : {}) }, signal.aborted);
          appendOptionalPolicyAudit(state, input.user, final, preflight.request);
          event(state, op, response ? "model.completed" : uncertain ? "model.outcome_unknown" : "model.failed", original.id);
          return final;
        });
      }).catch(error => { reconciliationRequired = true; controller.abort(); throw error; });
      if (uncertain) { reconciliationRequired = true; throw failure; }
    }
    // Recheck observed filesystem policy at each consuming owned scope. These
    // checks do not form an atomic transaction with the durable state store.
    const admittedPolicyHash = policy.policyHash, admittedPolicyPath = composition.config.governanceFallbackPolicyPath;
    const assertConsumedPolicyCurrent = async () => {
      if (!admittedPolicyHash) return;
      try { await assertLocalPolicyCurrent(admittedPolicyPath, { metadata: { policyHash: admittedPolicyHash } }); }
      catch (error) { reconciliationRequired = true; controller.abort(); throw error; }
    };
    const synchronizePolicy = async () => { await synchronize(); await assertConsumedPolicyCurrent(); };
    // Reconstruct services after the acknowledged policy phase has closed.
    // Discovery and other setup waits remain a separate migration boundary.
    const prepared = policy.decision !== "allow" ? await withFunctionResources(composition, async ({ repository, registries }) => {
      await synchronize(); await restoreImportedCapabilities(repository, registries);
      if (fingerprint(registries.snapshot().tools) !== admitted!.contractFingerprint) throw new Error("Original policy contracts changed before denial");
      const request = await prepareChatPolicyRequest({ repository, registries }, input.user, policyInput);
      if (digest(request.context) !== digest(preflight.request.context)) throw new Error("Original policy context changed before denial");
      if (policy.policyHash) await assertLocalPolicyCurrent(composition.config.governanceFallbackPolicyPath, { metadata: { policyHash: policy.policyHash } });
      return repository.readAuthoritative(state => {
        current(state); if (durableBinding(state) !== preflight.binding) throw new Error("Original policy binding changed before denial");
        assertChatPolicyContext(state, input.user, request);
        return { policy, tools: [] as ToolDefinition[], binding: preflight.binding, workspaceStatus: chatWorkspaceStatus(state, input.user, admitted!.sessionId),
          transport: undefined, connected: false, synthesis: undefined, nodeProposal: undefined };
      });
    }).catch(error => { reconciliationRequired = true; controller.abort(); throw error; }) : await withFunctionRuntime(composition, async ({ services }) => {
      const originalBinding = await validatePolicyRuntime(services, preflight.binding);
      const request = await prepareChatPolicyRequest(services, input.user, policyInput);
      if (digest(request.context) !== digest(preflight.request.context)) throw new Error("Original policy context changed before continuation");
      if (preflight.kind === "local") await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, preflight.selected.plan);
      let tools = policy.decision === "allow" && ["QUERY", "AUDIT"].includes(candidate.intent!) && services.erpbridgeSession
        ? (await discoverTools(services.erpbridgeSession, services.registries)).filter(tool => tool.is_read_only && tool.allowed_roles.includes(input.user.role)) : [];
      let synthesis: { input: SynthesisInput; candidate: PreparedCandidate; tools: readonly ToolDefinition[]; registryHash: string; toolsHash: string } | undefined;
      let nodeProposal: { prepared: PreparedNodeProposal; registryHash: string; toolsHash: string } | undefined;
      if (policy.decision === "allow" && synthesisRequest && services.synthesis) {
        const synthesisTools = await discoverTools(services.erpbridgeSession ?? null, services.registries);
        const bodyWorkflowCtx = isRecord(input.body.workflowContext) ? input.body.workflowContext : null;
        const workflowContextYaml = typeof bodyWorkflowCtx?.yaml === "string" && bodyWorkflowCtx.yaml.trim() ? bodyWorkflowCtx.yaml.trim() : null;
        const workflowContextName = typeof bodyWorkflowCtx?.name === "string" && bodyWorkflowCtx.name ? bodyWorkflowCtx.name : "Workflow";
        const contextMessages = workflowContextYaml ? [`assistant: I have the following workflow loaded for context:\n**${workflowContextName}**\n\`\`\`yaml\n${workflowContextYaml}\n\`\`\``, ...input.stored.priorMessages] : input.stored.priorMessages;
        const priorMessages = policy.source === "skipped" ? contextMessages : [...contextMessages,
          `assistant: Additional policy preflight (${policy.source}): ${policy.reason}. This is not execution permission; mandatory validation and approvals remain required.`];
        const modelSourceContext = await reviewedModelSourceContext(services, input.user, synthesisTools);
        const synthesisInput: SynthesisInput = { prompt: input.content, userRole: input.user.role,
          user: { id: input.user.id, role: input.user.role, department: input.user.departmentId }, priorMessages,
          modelSourceContext, traceId: admitted!.traceId, sessionId: admitted!.sessionId, messageId: stringValue(input.stored.userMessage.id),
          liveTools: synthesisTools, signal };
        const candidate = services.synthesis.prepareCandidate(synthesisInput);
        synthesis = { input: synthesisInput, candidate, tools: structuredClone(synthesisTools), registryHash: services.registries.hash(), toolsHash: fingerprint(synthesisTools) };
      }
      if (policy.decision === "allow" && nodeProposalRequest) {
        const context = nodeContextSchema.parse(input.body.nodeContext);
        const scoped = await services.repository.readAuthoritative(state => { current(state); return assertNodeContext(state, context, input.user); });
        const registryHash = services.registries.hash(), registrySnapshot = services.registries.snapshot();
        const preparedNode = prepareNodeProposal(scoped, context, input.content, registrySnapshot, registryHash, input.user.role);
        nodeProposal = { prepared: preparedNode, registryHash, toolsHash: fingerprint(registrySnapshot.tools) };
        await chatJobQueue(services).phaseHooks(admitted!, input.user, signal, synchronize).stage("GENERATING_NODE_PROPOSAL");
      }
      const snapshot = await services.repository.readAuthoritative(state => { current(state); if (durableBinding(state) !== originalBinding) throw new Error("Original policy binding changed during preflight"); return { binding: originalBinding, workspaceStatus: chatWorkspaceStatus(state, input.user, admitted!.sessionId) }; });
      await assertConsumedPolicyCurrent();
      return { policy, tools: structuredClone(tools), ...snapshot, transport: services.providerRuntime!.fetchImplementation,
        connected: Boolean(services.erpbridgeSession), synthesis, nodeProposal };
    }).catch(error => { reconciliationRequired = true; controller.abort(); throw error; });
    // Keep callbacks synchronous: awaited external work never enters mutations.
    const assertFresh = (state: Readonly<RepositoryState>) => {
      const op = current(state); if (durableBinding(state) !== prepared.binding) throw new Error("Original model, connection or policy configuration changed"); return op;
    };
    const saveAnswer = async (text: string, artifacts: Record<string, unknown>, binding = admitted!.modelBinding, queryPresentation = true) => {
      await synchronize();
      let publicationPrepared = false, callbackFailed = false, callbackError: unknown;
      try {
        await withFunctionResources(composition, async ({ repository }) => {
          try {
            await assertConsumedPolicyCurrent();
            await repository.mutate(state => {
              const op = assertFresh(state);
              if ((op.modelAttemptsSecret ?? []).some(attempt => ["DISPATCH_INTENT", "UNKNOWN"].includes(attempt.status)) || op.attempts.some(attempt => ["PREPARING", "DISPATCH_INTENT", "UNKNOWN"].includes(attempt.status)))
                throw new Error("Original chat has an unresolved dispatch");
              const chat = assertChatAuthority(state, input.user, op.sessionId);
              const enriched = { ...artifacts, ...(prepared.policy.source !== "skipped" ? { policyCheck: prepared.policy } : {}) };
              const message = { id: nextID(state, "msg"), role: "assistant", operationId: op.id, ...(queryPresentation ? { modelBinding: binding } : {}),
                ...(queryPresentation ? workspaceStatusAnswer(state, input.user, op.sessionId, text, enriched) : { text, artifacts: enriched }), createdAt: now(), traceId: op.traceId };
              chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
              op.assistantMessageId = message.id; op.status = "ANSWERED"; op.stage = "ANSWERED"; op.finishedAt = now(); delete op.inputCiphertext; delete op.inputFields; delete op.taskLeaseSecret;
              event(state, op, "answer.saved"); audit(state, op, "chat.answer.saved");
              publicationPrepared = true;
            });
          } catch (error) {
            callbackFailed = true; callbackError = error; throw error;
          }
        });
      } catch (error) {
        const knownPrePublicationFailure = callbackFailed && error === callbackError && !publicationPrepared;
        if (!knownPrePublicationFailure) { finalizationUnconfirmed = true; reconciliationRequired = true; controller.abort(); }
        throw error;
      }
    };
    const withFinalRuntime = async <T>(work: (services: HandlerServices) => Promise<T>): Promise<T> => {
      let callbackStarted = false, callbackCompleted = false, callbackFailed = false, callbackError: unknown;
      try {
        return await withFunctionRuntime(composition, async ({ services }) => {
          callbackStarted = true;
          try { await synchronizePolicy(); const result = await work(services); callbackCompleted = true; return result; }
          catch (error) { callbackFailed = true; callbackError = error; throw error; }
        });
      } catch (error) {
        const safeNodeFailure = error instanceof HandlerFailure && isRecord(error.meta) &&
          ["DRAFT_REVISION_CONFLICT", "NODE_PROPOSAL_INVALID"].includes(String(error.meta.code));
        const scopeFailure = callbackCompleted || !callbackStarted || callbackFailed && error !== callbackError;
        if (scopeFailure || !safeNodeFailure && error === callbackError) {
          reconciliationRequired = true;
          if (callbackCompleted || scopeFailure) finalizationUnconfirmed = true;
          controller.abort();
        }
        throw error;
      }
    };
    if (prepared.policy.decision !== "allow") {
      try {
        await saveAnswer(`**Request ${prepared.policy.failureCode ? "stopped: policy check failed" : prepared.policy.decision === "review" ? "needs policy review" : "blocked by policy"}.**\n\n${prepared.policy.reason}`, { intent: "POLICY_DENIAL", policyCheck: prepared.policy }, null, false);
      } catch (error) {
        // The answer may already be committed. Its ACK and owned scope close
        // must both be confirmed before returning a clean terminal receipt.
        finalizationUnconfirmed = true; reconciliationRequired = true; controller.abort(); throw error;
      }
    } else if (!prepared.connected && !prepared.synthesis && !prepared.nodeProposal) {
      await saveAnswer("ERPBridge is not connected. I cannot retrieve ERP data or execute tools for this request. No ERP operation was performed.", { intent: candidate.intent, blocked: true, code: "ERPBRIDGE_NOT_CONNECTED" }, null, false);
    } else {
      const configuration = input.provider;
      const generateCandidate = async (prompt: string, version: string, validate: (response: AnalysisResponse) => void,
        context: Omit<ProviderInvocationContext, "promptTemplateVersion" | "fallbackUsed">,
        purpose: "SYNTHESIS" | "NODE_PROPOSAL", expectedRegistryHash: string): Promise<AnalysisResponse> => {
        if (!context.egress) throw new Error("Model egress declaration is required");
        assertModelEgress(normalizeModelEgressPolicy(configuration.egressPolicy, configuration.baseURL), configuration.baseURL, context.egress);
        const models = [configuration.model, ...(configuration.fallbackModel && configuration.fallbackModel !== configuration.model ? [configuration.fallbackModel] : [])];
        let lastFailure: unknown;
        for (const [index, model] of models.entries()) {
          if (!configuredModels(configuration).includes(model)) throw new Error("Original selected model is no longer configured");
          await synchronize();
          const messages = generationMessages(prompt, version);
          const requestHash = digest({ prompt, version, context, model });
          const wireHash = digest({ model, messages, temperature: configuration.temperature,
            ...(context.maxOutputTokens === undefined ? {} : { max_tokens: context.maxOutputTokens }) });
          const id = `chatmodel_${digest([command.taskId, workerId, admitted!.epoch, ++ordinal, requestHash])}`;
          const started = performance.now();
          const attempt: ChatModelAttempt = { id, taskId: command.taskId, workerId, epoch: admitted!.epoch, expiresAt: new Date(deadlineAt).toISOString(), ordinal,
            requestHash, configurationFingerprint: fingerprint(configuration), configurationRevision: admitted!.modelBinding!.configurationRevision,
            model, promptTemplateVersion: version, egress: context.egress, status: "DISPATCH_INTENT", startedAt: now(), provenanceId: `inv_${id}`, purpose };
          let entered = false;
          const attemptRequests: OwnedJSONRequest[] = [];
          const boxed = await withFunctionResources(composition, async ({ repository, registries }) => {
            await synchronize(); await restoreImportedCapabilities(repository, registries);
            await assertConsumedPolicyCurrent();
            await repository.mutate(state => { const op = assertFresh(state);
              if (registries.hash() !== expectedRegistryHash || fingerprint(registries.snapshot().tools) !== op.contractFingerprint ||
                  (op.modelAttemptsSecret?.length ?? 0) >= 32 || op.modelAttemptsSecret?.some(a => ["DISPATCH_INTENT", "UNKNOWN"].includes(a.status)))
                throw new Error("Original model intent is unavailable");
              (op.modelAttemptsSecret ??= []).push(attempt); op.stage = purpose === "SYNTHESIS" ? "GENERATING" : "GENERATING_NODE_PROPOSAL";
              event(state, op, "model.dispatch_intent", id);
            });
            await assertConsumedPolicyCurrent();
            let unused = true;
            const send: typeof fetch = (url, init) => {
              repository.assertAuthority();
              if (!unused || signal.aborted) throw new Error("Exact model dispatch was fenced or consumed");
              unused = false; entered = true;
              if (String(url) !== `${configuration.baseURL.trim().replace(/\/+$/, "")}/chat/completions` || init?.method !== "POST" || digest(JSON.parse(String(init.body))) !== wireHash)
                throw new Error("Exact acknowledged generation request does not match transport entry");
              return (prepared.transport ?? fetch)(url, init);
            };
            const client = new OpenAICompatibleClient({ ...configuration, fetchImplementation: send,
              ownRequest: request => { ownRequest(request); attemptRequests.push(request); } });
            const pending = client.generate(prompt, model, signal, { ...context, promptTemplateVersion: version });
            void pending.catch(() => {});
            if (!entered) throw new Error("Exact generation transport did not enter while writer was owned");
            return { pending };
          }).catch(async error => { reconciliationRequired = true; controller.abort(); await drain(attemptRequests, true); throw error; });
          let generated: AnalysisResponse | undefined, failure: unknown;
          try { generated = await boxed.pending; try { validate(generated); } catch (error) {
            generated = undefined;
            failure = new OpenAICompatibleError(`Generated response was malformed: ${error instanceof Error ? error.message : String(error)}`, "malformed");
          } } catch (error) { failure = error; }
          if (!await drain(attemptRequests, failure !== undefined)) { reconciliationRequired = true; controller.abort(); throw new Error("Original generation transport disposal is unconfirmed"); }
          const uncertain = failure instanceof OpenAICompatibleError && ["timeout", "transport", "cancelled"].includes(failure.kind);
          await synchronize();
          await withFunctionResources(composition, async ({ repository }) => {
            await assertConsumedPolicyCurrent();
            return repository.mutate(state => {
              const op = assertFresh(state), original = op.modelAttemptsSecret?.find(a => a.id === id);
              if (!original || original.status !== "DISPATCH_INTENT" || original.requestHash !== requestHash || original.workerId !== workerId || original.epoch !== op.epoch)
                throw new Error("Original generation result intention changed");
              const bytes = generated ? Buffer.from(JSON.stringify(generated)) : undefined;
              storeChatModelContent(op.modelAttemptsSecret??[],original,bytes,composition.config.firestoreContentFormat==="native-fields/v1",codec);
              original.status = generated ? "DONE" : uncertain ? "UNKNOWN" : "FAILED"; original.completedAt = now();
              state.invocationProvenance[attempt.provenanceId] = { id: attempt.provenanceId, promptTemplateVersion: version,
                promptSha256: generationPromptHash(prompt, version), provider: configuration.type, providerId: configuration.id,
                configurationRevision: attempt.configurationRevision, model, inputTokens: generated?.inputTokens ?? 0, outputTokens: generated?.outputTokens ?? 0,
                measured: generated?.measured === true, latencyMs: Math.max(0, performance.now() - started), temperature: configuration.temperature,
                fallbackUsed: index > 0, status: generated ? "SUCCEEDED" : "FAILED", createdAt: now(), ...context };
              event(state, op, generated ? "model.completed" : uncertain ? "model.outcome_unknown" : "model.failed", id);
            });
          }).catch(error => { reconciliationRequired = true; controller.abort(); throw error; });
          if (generated) return { ...generated, model, provider: configuration.type };
          lastFailure = failure;
          if (index === 0 && models.length > 1 && failure instanceof OpenAICompatibleError && ["rate_limit", "server", "malformed"].includes(failure.kind)) continue;
          throw failure;
        }
        throw lastFailure ?? new Error("Original generation model could not be used");
      };
      const query = async (messages: QueryMessage[], tools: QueryToolDefinition[], queryOptions: QueryOptions): Promise<QueryTurnResult> => {
        assertToolQueryPromptContract(messages, queryOptions.promptTemplateVersion);
        if (!queryOptions.context?.egress) throw new Error("Model egress declaration is required");
        assertModelEgress(normalizeModelEgressPolicy(configuration.egressPolicy, configuration.baseURL), configuration.baseURL, queryOptions.context.egress);
        const requestedModel = queryOptions.model?.trim() || configuration.model, backup = configuration.fallbackModel?.trim();
        const affinity = queryOptions.allowFallback ? latestContinuationModel(messages, configuration.baseURL.trim().replace(/\/+$/, "")) : undefined;
        const selected = affinity && affinity === backup ? affinity : requestedModel;
        const models = queryOptions.allowFallback && backup && backup !== selected ? [selected, backup] : [selected];
        for (const [index, model] of models.entries()) {
          if (!configuredModels(configuration).includes(model)) throw new Error("Original selected model is no longer configured");
          await synchronize();
          const requestHash = digest({ messages, tools, model, maxOutputTokens: queryOptions.maxOutputTokens, prompt: queryOptions.promptTemplateVersion, egress: queryOptions.context.egress });
          const wireHash = digest({ model, messages: providerWireMessages(messages, model, configuration.baseURL.trim().replace(/\/+$/, "")), tools: tools.length ? tools : undefined,
            temperature: configuration.temperature, ...(queryOptions.maxOutputTokens === undefined ? {} : { max_tokens: queryOptions.maxOutputTokens }) });
          const id = `chatmodel_${digest([command.taskId, workerId, admitted!.epoch, ++ordinal, requestHash])}`, started = performance.now();
          const attempt: ChatModelAttempt = { id, taskId: command.taskId, workerId, epoch: admitted!.epoch, expiresAt: new Date(deadlineAt).toISOString(), ordinal,
            requestHash, configurationFingerprint: fingerprint(configuration), configurationRevision: admitted!.modelBinding!.configurationRevision,
            model, promptTemplateVersion: queryOptions.promptTemplateVersion!, egress: queryOptions.context.egress, status: "DISPATCH_INTENT", startedAt: now(), provenanceId: `inv_${id}` };
          let entered = false;
          const attemptRequests: OwnedJSONRequest[] = [];
          const boxed = await withFunctionResources(composition, async ({ repository, registries }) => {
            await synchronize(); await restoreImportedCapabilities(repository, registries);
            await assertConsumedPolicyCurrent();
            await repository.mutate(state => { const op = assertFresh(state);
              if (fingerprint(registries.snapshot().tools) !== op.contractFingerprint || (op.modelAttemptsSecret?.length ?? 0) >= 32 || op.modelAttemptsSecret?.some(a => ["DISPATCH_INTENT", "UNKNOWN"].includes(a.status))) throw new Error("Original model intent is unavailable");
              (op.modelAttemptsSecret ??= []).push(attempt); op.stage = "MODEL"; event(state, op, "model.dispatch_intent", id);
            });
            await assertConsumedPolicyCurrent();
            let unused = true;
            const send: typeof fetch = (url, init) => {
              repository.assertAuthority(); if (!unused || signal.aborted || queryOptions.signal?.aborted) throw new Error("Exact model dispatch was fenced or consumed"); unused = false; entered = true;
              if (String(url) !== `${configuration.baseURL.trim().replace(/\/+$/, "")}/chat/completions` || init?.method !== "POST" || digest(JSON.parse(String(init.body))) !== wireHash)
                throw new Error("Exact acknowledged model request does not match transport entry");
              return (prepared.transport ?? fetch)(url, init);
            };
            const client = new OpenAICompatibleClient({ ...configuration, fetchImplementation: send,
              ownRequest: request => { ownRequest(request); attemptRequests.push(request); } });
            const pending = client.queryWithTools(messages, tools, { ...queryOptions, model, signal: queryOptions.signal ? AbortSignal.any([signal, queryOptions.signal]) : signal });
            void pending.catch(() => {});
            if (!entered) throw new Error("Exact model transport did not enter while writer was owned");
            return { pending };
          }).catch(async error => { reconciliationRequired = true; controller.abort(); await drain(attemptRequests, true); throw error; });
          let turn: QueryTurnResult | undefined, failure: unknown;
          try { turn = await boxed.pending; } catch (error) { failure = error; }
          if (!await drain(attemptRequests, failure !== undefined)) { reconciliationRequired = true; controller.abort(); throw new Error("Original model transport disposal is unconfirmed"); }
          const uncertain = failure instanceof OpenAICompatibleError && ["timeout", "transport", "cancelled"].includes(failure.kind);
          await synchronize();
          await withFunctionResources(composition, async ({ repository }) => {
            await assertConsumedPolicyCurrent();
            return repository.mutate(state => {
              const op = assertFresh(state), original = op.modelAttemptsSecret?.find(a => a.id === id);
              if (!original || original.status !== "DISPATCH_INTENT" || original.requestHash !== requestHash || original.workerId !== workerId || original.epoch !== op.epoch) throw new Error("Original model result intention changed");
              const bytes = turn ? Buffer.from(JSON.stringify(turn)) : undefined;
              storeChatModelContent(op.modelAttemptsSecret??[],original,bytes,composition.config.firestoreContentFormat==="native-fields/v1",codec);
              original.status = turn ? "DONE" : uncertain ? "UNKNOWN" : "FAILED"; original.completedAt = now();
              state.invocationProvenance[attempt.provenanceId] = { id: attempt.provenanceId, promptTemplateVersion: attempt.promptTemplateVersion,
                promptSha256: `sha256:${createHash("sha256").update(JSON.stringify({ messages, tools })).digest("hex")}`, provider: configuration.type, providerId: configuration.id,
                configurationRevision: attempt.configurationRevision, model, inputTokens: turn?.inputTokens ?? 0, outputTokens: turn?.outputTokens ?? 0, measured: turn?.measured === true,
                latencyMs: Math.max(0, performance.now() - started), temperature: configuration.temperature, fallbackUsed: model !== requestedModel, status: turn ? "SUCCEEDED" : "FAILED", createdAt: now(), ...queryOptions.context };
              event(state, op, turn ? "model.completed" : uncertain ? "model.outcome_unknown" : "model.failed", id);
            });
          }).catch(error => { reconciliationRequired = true; controller.abort(); throw error; });
          if (turn) return { ...turn, model, provider: configuration.type, configurationRevision: attempt.configurationRevision,
            ...(queryOptions.allowFallback ? { modelRouting: { requestedModel, model, fallbackUsed: model !== requestedModel }, ...(index > 0 ? { measured: false } : {}) } : {}) };
          if (index === 0 && models.length > 1 && !uncertain && isQueryFallbackEligible(failure)) continue;
          throw failure;
        }
        throw new Error("Original query model could not be used");
      };
      if (prepared.nodeProposal) {
        const node = prepared.nodeProposal;
        let generated: AnalysisResponse;
        try { generated = await generateCandidate(node.prepared.prompt, node.prepared.promptTemplateVersion,
          response => validateNodeProposalOutput(node.prepared, response),
          { traceId: admitted.traceId, sessionId: admitted.sessionId, workflowId: node.prepared.context.workflowId,
            actor: { id: input.user.id, role: input.user.role }, egress: { purpose: "interactive", dataClass: "restricted" } }, "NODE_PROPOSAL", node.registryHash); }
        catch (error) {
          if (error instanceof OpenAICompatibleError && error.kind === "malformed")
            throw new HandlerFailure(422, "A supported node patch was not returned; nothing was changed", { code: "NODE_PROPOSAL_INVALID" });
          throw error;
        }
        await withFinalRuntime(async services => {
          await synchronize(); await restoreImportedCapabilities(services.repository, services.registries);
          await services.repository.readAuthoritative(state => assertFresh(state));
          if (services.registries.hash() !== node.registryHash || fingerprint(services.registries.snapshot().tools) !== node.toolsHash ||
              fingerprint(services.registries.snapshot().tools) !== admitted!.contractFingerprint)
            throw new Error("Original node registry or contracts changed during generation");
          const currentScoped = await services.repository.readAuthoritative(state => { assertFresh(state); return assertNodeContext(state, node.prepared.context, input.user); });
          const hooks = chatJobQueue(services).phaseHooks(admitted!, input.user, signal, synchronizePolicy);
          return finishNodeProposal({ prepared: node.prepared, currentScoped, generated, sessionId: admitted!.sessionId, traceId: admitted!.traceId,
            user: input.user, services, hooks, modelBinding: { ...admitted!.modelBinding!, model: generated.model } });
        });
      } else if (prepared.synthesis) {
        const synthesis = prepared.synthesis;
        const generated = await generateCandidate(synthesis.candidate.prompt, CANDIDATE_PROMPT_VERSION,
          response => { parseWorkflowYAMLStrict(response.text.trim()); },
          { traceId: admitted.traceId, sessionId: admitted.sessionId, ...(synthesis.input.messageId ? { messageId: synthesis.input.messageId } : {}), candidateId: synthesis.candidate.candidateId,
            actor: { id: input.user.id, role: input.user.role }, egress: { purpose: "interactive", dataClass: "restricted" } }, "SYNTHESIS", synthesis.registryHash);
        await withFinalRuntime(async services => {
          await synchronize(); await restoreImportedCapabilities(services.repository, services.registries);
          await services.repository.readAuthoritative(state => assertFresh(state));
          if (services.registries.hash() !== synthesis.registryHash || fingerprint(services.registries.snapshot().tools) !== admitted!.contractFingerprint)
            throw new Error("Original generation registry or contracts changed");
          const liveTools = await discoverTools(services.erpbridgeSession ?? null, services.registries);
          await assertConsumedPolicyCurrent();
          if (fingerprint(liveTools) !== synthesis.toolsHash) throw new Error("Original generation tools changed during model wait");
          if (!services.providerRuntime?.restoreCaptured) throw new Error("Original generation provider is unavailable");
          const providerRuntime = services.providerRuntime.restoreCaptured(input.provider!, admitted!.modelBinding!.configurationRevision);
          const freshServices = withSelectedProvider(services, providerRuntime);
          const hooks = chatJobQueue(freshServices).phaseHooks(admitted!, input.user, signal, synchronizePolicy);
          return processStoredChat({ body: input.body, content: input.content, sessionId: admitted!.sessionId, traceId: admitted!.traceId,
            stored: input.stored, user: input.user, services: freshServices, signal, hooks,
            preGeneratedCandidate: { input: synthesis.input, prepared: synthesis.candidate, generated, liveTools, admittedPolicy: prepared.policy } });
        });
      } else {
        const result = await runQueryLoop({ userMessage: input.content, chatHistory: queryChatHistory(input.body, input.stored, prepared.policy), workspaceStatus: prepared.workspaceStatus,
          sessionId: admitted.sessionId, actorId: input.user.id, actorRole: input.user.role, traceId: admitted.traceId, signal }, prepared.tools,
          async (name, args) => {
             let phasedAttempt: ChatAttempt | undefined, phasedTicket: object | undefined;
             const localEnabled = await phases.read(state => {
               current(state); const switches = policySwitches(state.settings.rbac);
               return switches.local;
             });
             if (localEnabled) {
               const requests: OwnedJSONRequest[] = [];
               const staged = await withFunctionRuntime(composition, async ({ services }) => {
                 await validatePolicyRuntime(services, prepared.binding);
                 await assertConsumedPolicyCurrent();
                 const switches = await services.repository.readAuthoritative(state => { assertFresh(state); return policySwitches(state.settings.rbac); });
                 if (!switches.local) throw new Error("Original per-read policy switches changed");
                 const tools = await discoverTools(services.erpbridgeSession ?? null, services.registries);
                 const matches = tools.filter(tool => tool.name === name || tool.mcp_tool_name === name);
                 if (matches.length !== 1) throw new Error("Original read has no unique live contract");
                 const tool = matches[0]!;
                 const actor = await services.repository.effectiveUser(input.user.id);
                 if (!actor || actor.status.toLowerCase() !== "active" || actor.role !== input.user.role ||
                     digest([...actor.permissions].sort()) !== digest([...input.user.permissions].sort())) throw new Error("Original read actor changed");
                 const hooks = chatJobQueue(services).phaseHooks(admitted!, input.user, signal, synchronizePolicy);
                 const attempt = await hooks.prepareRead(name, args);
                 const request = { prompt: `Read ERP data using ${tool.display_name ?? tool.name}`, action: tool.mcp_tool_name,
                   context: { actions: [tool.name, tool.mcp_tool_name], arguments: structuredClone(args), readOnly: true, domain: tool.module },
                   signal, traceId: admitted!.traceId, sessionId: admitted!.sessionId };
                 const selected = await prepareOptionalPolicy(withSelectedProvider(services, services.providerRuntime!.restoreCaptured(input.provider!, admitted!.modelBinding!.configurationRevision)), actor, request);
                 if (selected.kind === "decision") {
                   await validatePolicyRuntime(services, prepared.binding);
                   const localPolicyHash = selected.decision.source === "local_model" ? selected.decision.policyHash : undefined;
                   if (localPolicyHash) await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, { metadata: { policyHash: localPolicyHash } });
                   const decision = await services.repository.mutate(state => {
                     const op = assertFresh(state), original = op.attempts.find(item => item.id === attempt.id);
                     if (!original || digest(original) !== digest(attempt) || original.status !== "PREPARING") throw new Error("Original per-read policy result intention changed");
                     const settled = finalOptionalPolicy(state, input.user, selected.settings,
                       { ...selected.decision, fallbackUsed: selected.fallbackUsed }, signal.aborted);
                     appendOptionalPolicyAudit(state, input.user, settled, { traceId: admitted!.traceId, sessionId: admitted!.sessionId });
                     return settled;
                   });
                   return { kind: "decision" as const, attempt, toolId: tool.tool_id, contractHash: capabilityContractHash(tool),
                     settings: JSON.stringify(selected.settings), decision, localPolicyHash };
                 }
                 const plan = selected.plan, configuration = input.provider!, model = configuration.model;
                 assertModelEgress(normalizeModelEgressPolicy(configuration.egressPolicy, configuration.baseURL), configuration.baseURL, plan.context.egress!);
                 await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, plan);
                 await validatePolicyRuntime(services, prepared.binding);
                 const requestHash = digest({ attempt, toolId: tool.tool_id, contractHash: capabilityContractHash(tool), args, prompt: plan.prompt, context: plan.context, model, policy: plan.metadata });
                 const wireHash = digest(generationRequestBody(configuration.baseURL, model, configuration.temperature, plan.prompt, plan.context));
                 const id = `chatmodel_${digest([command.taskId, workerId, admitted!.epoch, ++ordinal, requestHash])}`, started = performance.now();
                 const modelAttempt: ChatModelAttempt = { id, taskId: command.taskId, workerId, epoch: admitted!.epoch, expiresAt: new Date(deadlineAt).toISOString(), ordinal,
                   requestHash, configurationFingerprint: fingerprint(configuration), configurationRevision: admitted!.modelBinding!.configurationRevision,
                   model, promptTemplateVersion: "prompt/local-policy/v2", egress: plan.context.egress!, status: "DISPATCH_INTENT", startedAt: now(), provenanceId: `inv_${id}`, purpose: "POLICY_PREFLIGHT" };
                 await services.repository.mutate(state => {
                   const op = assertFresh(state), original = op.attempts.find(item => item.id === attempt.id);
                   if (!original || digest(original) !== digest(attempt) || original.status !== "PREPARING" ||
                       (op.modelAttemptsSecret?.length ?? 0) >= 32 || op.modelAttemptsSecret?.some(item => ["DISPATCH_INTENT", "UNKNOWN"].includes(item.status)))
                     throw new Error("Original per-read policy intention is unavailable");
                   (op.modelAttemptsSecret ??= []).push(modelAttempt); event(state, op, "model.dispatch_intent", id);
                 });
                 await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, plan);
                 await validatePolicyRuntime(services, prepared.binding);
                 const transport = services.providerRuntime!.fetchImplementation ?? fetch, repository = services.repository;
                 let entered = false, unused = true;
                 const send: typeof fetch = (url, init) => {
                   repository.assertAuthority();
                   if (!unused || signal.aborted || Date.now() >= deadlineAt) throw new Error("Original per-read policy dispatch is fenced or consumed");
                   unused = false;
                   if (String(url) !== `${configuration.baseURL.trim().replace(/\/+$/, "")}/chat/completions` || init?.method !== "POST" || digest(JSON.parse(String(init.body))) !== wireHash)
                     throw new Error("Original per-read policy wire request changed");
                   entered = true; return transport(url, init);
                 };
                 const client = new OpenAICompatibleClient({ ...configuration, fetchImplementation: send, ownRequest: owned => { ownRequest(owned); requests.push(owned); } });
                 const pending = client.generate(plan.prompt, model, signal, plan.context); void pending.catch(() => {});
                 if (!entered) throw new Error("Original per-read policy transport did not enter");
                 return { kind: "local" as const, attempt, toolId: tool.tool_id, contractHash: capabilityContractHash(tool), settings: JSON.stringify(selected.settings), selected, modelAttempt, pending, started };
               }).catch(async error => { reconciliationRequired = true; controller.abort(); await drain(requests, true); throw error; });
               phasedAttempt = staged.attempt;
               if (staged.kind === "local") {
                 let response: AnalysisResponse | undefined, failure: unknown;
                 try { response = await staged.pending; } catch (error) { failure = error; }
                 if (!await drain(requests, failure !== undefined)) { reconciliationRequired = true; controller.abort(); throw new Error("Original per-read policy transport disposal is unconfirmed"); }
                 const uncertain = failure !== undefined && (!(failure instanceof OpenAICompatibleError) || ["timeout", "transport", "cancelled"].includes(failure.kind));
                 const decision = interpretLocalPolicy(staged.selected.plan, response, failure, signal.aborted);
                 const final = await withFunctionRuntime(composition, async ({ services }) => {
                   await validatePolicyRuntime(services, prepared.binding);
                   await assertLocalPolicyCurrent(services.config.governanceFallbackPolicyPath, staged.selected.plan);
                   return services.repository.mutate(state => {
                     const op = assertFresh(state), original = op.modelAttemptsSecret?.find(item => item.id === staged.modelAttempt.id), read = op.attempts.find(item => item.id === staged.attempt.id);
                     if (!original || digest(original) !== digest(staged.modelAttempt) || original.status !== "DISPATCH_INTENT" ||
                         !read || digest(read) !== digest(staged.attempt) || read.status !== "PREPARING" ||
                         op.modelAttemptsSecret?.some(item => item.id !== original.id && ["DISPATCH_INTENT", "UNKNOWN"].includes(item.status)))
                       throw new Error("Original per-read policy result intention changed");
                     const bytes = response ? Buffer.from(JSON.stringify(response)) : undefined;
                     storeChatModelContent(op.modelAttemptsSecret??[],original,bytes,composition.config.firestoreContentFormat==="native-fields/v1",codec);
                     original.status = response ? "DONE" : uncertain ? "UNKNOWN" : "FAILED"; original.completedAt = now();
                     state.invocationProvenance[original.provenanceId] = { id: original.provenanceId,
                       promptSha256: generationPromptHash(staged.selected.plan.prompt, original.promptTemplateVersion), provider: input.provider!.type, providerId: input.provider!.id,
                       configurationRevision: original.configurationRevision, model: original.model, inputTokens: response?.inputTokens ?? 0, outputTokens: response?.outputTokens ?? 0,
                       measured: response?.measured === true, latencyMs: Math.max(0, performance.now() - staged.started), temperature: input.provider!.temperature,
                       fallbackUsed: staged.selected.fallbackUsed, status: response ? "SUCCEEDED" : "FAILED", createdAt: now(), ...staged.selected.plan.context };
                     const settled = finalOptionalPolicy(state, input.user, staged.selected.settings,
                       { ...decision, fallbackUsed: staged.selected.fallbackUsed }, signal.aborted);
                     appendOptionalPolicyAudit(state, input.user, settled, { traceId: admitted!.traceId, sessionId: admitted!.sessionId });
                     event(state, op, response ? "model.completed" : uncertain ? "model.outcome_unknown" : "model.failed", original.id);
                     return settled;
                   });
                 }).catch(error => { reconciliationRequired = true; controller.abort(); throw error; });
                 if (uncertain) { reconciliationRequired = true; throw failure; }
                 phasedTicket = bindPhasedReadPolicy({ actorId: input.user.id, toolId: staged.toolId, contractHash: staged.contractHash,
                   arguments: canonicalJSONBytes(args), settings: staged.settings, decision: final,
                   policyPath: composition.config.governanceFallbackPolicyPath, localPolicyHash: staged.selected.plan.metadata.policyHash });
               } else {
                 phasedTicket = bindPhasedReadPolicy({ actorId: input.user.id, toolId: staged.toolId, contractHash: staged.contractHash,
                   arguments: canonicalJSONBytes(args), settings: staged.settings, decision: staged.decision,
                   policyPath: composition.config.governanceFallbackPolicyPath,
                   ...(staged.localPolicyHash ? { localPolicyHash: staged.localPolicyHash } : {}) });
               }
             }
            const boxed = await withFunctionRuntime(composition, async ({ services }) => {
            await synchronizePolicy(); await services.repository.readAuthoritative(state => assertFresh(state));
            const assertRuntimeBinding = () => {
              if (fingerprint({ binding: services.erpbridgeSession?.admissionBinding ?? null, roles: services.config.erpbridgeRoleMap }) !== admitted!.connectionFingerprint || fingerprint(services.registries.snapshot().tools) !== admitted!.contractFingerprint ||
                  fingerprint(services.providerRuntime?.snapshot(input.provider!.model).configuration) !== fingerprint(input.provider))
                throw new Error("Original tool connection, contracts or provider changed");
            };
            assertRuntimeBinding();
            if (!services.providerRuntime?.restoreCaptured) throw new Error("Original tool-policy provider is unavailable");
            const providerRuntime = services.providerRuntime.restoreCaptured(input.provider!, admitted!.modelBinding!.configurationRevision);
            const scopedServices = withSelectedProvider(services, providerRuntime);
             const previous = await services.repository.readAuthoritative(state => assertFresh(state).attempts.map(attempt => attempt.id));
            const hooks = chatJobQueue(services).phaseHooks(admitted!, input.user, signal, synchronizePolicy);
            let preparing: ChatAttempt | undefined;
            try {
               const dispatch = async (beforeDispatch: (role: string) => Promise<void>) => {
                 preparing = phasedAttempt ?? await services.repository.readAuthoritative(state => {
                  const op = assertFresh(state), added = op.attempts.filter(attempt => !previous.includes(attempt.id));
                  if (added.length !== 1 || added[0]!.status !== "PREPARING" || added[0]!.toolName !== name || added[0]!.argumentHash !== digest(args))
                    throw new Error("Original read preparation changed");
                  return structuredClone(added[0]!);
                });
                 return dispatchReadTool(scopedServices, input.user.id, name, args, { signal, traceId: admitted!.traceId, sessionId: admitted!.sessionId, beforeDispatch,
                   ...(phasedTicket ? { phasedPolicy: phasedTicket } : {}) });
               };
               const output = phasedAttempt ? await hooks.resumeRead(phasedAttempt, name, args, dispatch) : await hooks.read(name, args, dispatch);
              return { output: structuredClone(output) };
            } catch (error) {
              const receipt = observedReadPolicyFailure(error, { repository: services.repository, actorId: input.user.id, toolName: name, args });
              const reason = receipt && policyStopReason(receipt);
              if (!reason || !preparing) throw error;
              await synchronize(); assertRuntimeBinding();
              const stop = await services.repository.readAuthoritative(state => {
                const op = assertFresh(state), attempt = op.attempts.find(item => item.id === preparing!.id);
                 if (op.attempts.length !== previous.length + (phasedAttempt ? 0 : 1) || !attempt || attempt.status !== "FAILED" || !attempt.completedAt ||
                    digest({ ...attempt, status: "PREPARING", completedAt: undefined, output: undefined }) !== digest(preparing) || digest(attempt.output) !== digest(receipt) ||
                    operationBinding(op) !== operationBinding(admitted!) || !policyStopJournalMatches(state, op, attempt.id)) throw error;
                return { reason, binding: prepared.binding, operationBinding: operationBinding(op), attempt: structuredClone(attempt) };
              });
              // Fulfill only this private callback. Runtime teardown must also
              // fulfill before the observation can become a clean stop proof.
              return { stop: { ...stop, error } };
            }
          }).catch(error => { reconciliationRequired = true; controller.abort(); throw error; });
            if (boxed.stop) {
              if (signal.aborted) { reconciliationRequired = true; throw boxed.stop.error; }
              cleanPolicyStop = boxed.stop; controller.abort(); throw boxed.stop.error;
            }
            return boxed.output;
          }, { queryWithTools: query });
        // The query loop intentionally catches tool failures. Do not publish its
        // presentation after this exact observed policy stop.
        if (cleanPolicyStop) throw cleanPolicyStop.error;
        const presentation = queryChatPresentation(candidate.intent!, input.content, admitted.modelBinding, result);
        await saveAnswer(result.text, presentation.artifacts, presentation.answerBinding);
      }
    }
  } catch (error) {
    controller.abort();
    if (!admitted) throw error;
    // A terminal cancellation is truthful only after every owned request and
    // its stop-control reader have finished. Unknown cleanup remains recovery.
    observing.abort(); await watch;
    const transportsDisposed = await drain([...transports.keys()], true);
    if (!transportsDisposed) reconciliationRequired = true;
    if (cleanPolicyStop) {
      try { if (await control.requested(admitted, observationSignal)) stopRequested = true; }
      catch { reconciliationRequired = true; }
    }
    try { await control.close(); controlClosed = true; }
    catch { reconciliationRequired = true; }
    try { await phases.mutate(state => {
      const op = state.chatOperations[command.operationId];
      if (!op || op.status !== "RUNNING" || op.epoch !== admitted!.epoch || op.workerId !== workerId) return;
      if (stopRequested && !op.cancellationRequested) { op.cancellationRequested = true; event(state, op, "operation.cancel_requested"); audit(state, op, "chat.operation.cancel_requested"); }
      const unresolvedTool = op.attempts.some(a => ["PREPARING", "DISPATCH_INTENT", "UNKNOWN"].includes(a.status));
      const unresolvedModel = (op.modelAttemptsSecret ?? []).some(a => ["DISPATCH_INTENT", "UNKNOWN"].includes(a.status));
      const explicitStop = stopRequested && op.cancellationRequested;
      let policyStopFresh = false;
      if (cleanPolicyStop && error === cleanPolicyStop.error && !stopRequested && !op.cancellationRequested && !options.signal?.aborted && !composition.signal?.aborted && !timeoutSignal.aborted &&
          Date.now() < deadlineAt && transportsDisposed && controlClosed && !reconciliationRequired && !finalizationUnconfirmed && !unresolvedTool && !unresolvedModel) {
        try {
          const lease = chatTaskLeaseSchema.parse(op.taskLeaseSecret), attempt = op.attempts.find(item => item.id === cleanPolicyStop!.attempt.id);
          authorizeChatOperation(state, op, input.user);
          policyStopFresh = assertChatTaskOutbox(op).taskId === command.taskId && lease.workerId === workerId && lease.epoch === op.epoch && lease.expiresAt === new Date(deadlineAt).toISOString() &&
            operationBinding(op) === cleanPolicyStop.operationBinding && durableBinding(state) === cleanPolicyStop.binding && digest(attempt) === digest(cleanPolicyStop.attempt) &&
            policyStopJournalMatches(state, op, cleanPolicyStop.attempt.id);
        } catch { policyStopFresh = false; }
      }
      if (explicitStop && transportsDisposed && controlClosed && !reconciliationRequired && !unresolvedTool && Date.now() < deadlineAt) {
        for (const attempt of op.modelAttemptsSecret ?? []) if (attempt.status === "DISPATCH_INTENT") {
          attempt.status = "UNKNOWN"; attempt.completedAt = now(); event(state, op, "model.interrupted", attempt.id);
        }
        op.status = "CANCELLED"; op.stage = "CANCELLED"; op.finishedAt = now(); op.reason = "PROCESSING_STOPPED"; delete op.inputCiphertext; delete op.inputFields; delete op.taskLeaseSecret;
        event(state, op, "operation.stopped"); audit(state, op, "chat.operation.stopped"); }
      else if (unresolvedTool || unresolvedModel || reconciliationRequired || Date.now() >= deadlineAt || cleanPolicyStop && !policyStopFresh) reconcileChatOperation(state, op, "CHAT_PHASE_OUTCOME_UNCONFIRMED");
      else { op.status = "FAILED"; op.stage = op.status; op.finishedAt = now();
        const code = error instanceof HandlerFailure && isRecord(error.meta) && typeof error.meta.code === "string" ? error.meta.code : null;
        op.reason = policyStopFresh ? cleanPolicyStop!.reason : code === "DRAFT_REVISION_CONFLICT" || code === "NODE_PROPOSAL_INVALID" ? code : "PROCESSING_STOPPED";
        delete op.inputCiphertext; delete op.inputFields; delete op.taskLeaseSecret;
        event(state, op, "operation.stopped"); audit(state, op, "chat.operation.stopped"); }
    }); } catch (terminalError) {
      if (!cleanPolicyStop) throw terminalError;
      reconciliationRequired = true; finalizationUnconfirmed = true;
      // An ACK or phase-close failure may follow a committed FAILED write.
      // Reconcile only the same original claim/receipt; never replay its work.
      try { await phases.mutate(state => {
        const op = state.chatOperations[command.operationId];
        if (!op || op.epoch !== admitted!.epoch || op.workerId !== workerId || operationBinding(op) !== cleanPolicyStop!.operationBinding ||
            !["RUNNING", "FAILED"].includes(op.status) || op.status === "FAILED" && op.reason !== cleanPolicyStop!.reason ||
            digest(op.attempts.find(attempt => attempt.id === cleanPolicyStop!.attempt.id)) !== digest(cleanPolicyStop!.attempt))
          throw new Error("Original policy stop finalization cannot be reconciled");
        reconcileChatOperation(state, op, "CHAT_PHASE_OUTCOME_UNCONFIRMED");
      }); } catch { /* Preserve the unconfirmed outcome for original delivery. */ }
      throw terminalError;
    }
  } finally {
    observing.abort(); controller.abort(); await watch;
    const disposed = await drain([...transports.keys()], true); if (!controlClosed) await control.close();
    if (!disposed) throw new Error("Chat invocation transport disposal was not confirmed; retry original delivery only");
  }
  if (finalizationUnconfirmed) throw new Error("Chat final phase finalization is unconfirmed; retry original delivery only");
  return phases.read(state => chatTaskReceipt(state, command));
}
