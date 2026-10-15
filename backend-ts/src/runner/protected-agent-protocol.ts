import type { QueryMessage, QueryTurnResult, QueryToolDefinition } from "../analysisprovider/query-types.js";
import { assertProviderContinuation, assistantToolCallMessage } from "../analysisprovider/provider-continuation.js";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { promptData, RUNTIME_AGENT_SYSTEM_PROMPT } from "../prompts/contracts.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { assertProtectedAgentRecords, type ProtectedAgentRecords, type ProtectedAgentProgress, type ProtectedAgentTurn } from "../repository/protected-agent-records.js";
import { protectedInvocationOperationKey, protectedJournalHash as hash, type ProtectedInvocationLedgerSnapshot } from "../repository/protected-invocation-records.js";
import { exactBridgeName, hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { mcpResultForModel, safeMcpToolResult } from "../tools/mcp-result.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { validateValue } from "../structured-output/validate.js";
import { modelInputItemCount } from "../workflows/model-input.js";
import type { OperationAgentNode } from "../workflows/compiled-read.js";
import type { ProtectedMachinePoint } from "../workflows/protected-machine-state.js";
import { RUNTIME_AGENT_PROMPT_VERSION, RuntimeAgentKnownFailure } from "./runtime-agent.js";
import type { Execution } from "../repository/store.js";
import type { CompiledProtectedOperationPlan } from "../workflows/protected-operation-compiler.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";

type Context = { node: OperationAgentNode; point: ProtectedMachinePoint; model: string; tools: readonly ToolDefinition[] };
const denied = (message: string): never => { throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", message); };
const invalid = (message: string): never => { throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", message); };
const exhausted = (): never => { throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Protected agent budget was exhausted"); };
// String-valued message fields must survive canonical storage property order.
// Historical runtime-agent/v1 orchestration remains untouched.
const dataMessage = (value: unknown) => promptData(JSON.parse(canonicalJSONBytes(value).toString("utf8")));

export function protectedAgentProgress(context: Context, startedAt: number): Extract<ProtectedAgentProgress, { profile: "protected-agent-invocation/v2" }> {
  const { node, point, model } = context;
  assertBoundedFiniteJSON({ node, point });
  if (point.kind !== "action" || !point.valid || point.scope !== "invocation" || point.nodeId !== node.id || !Object.hasOwn(point, "arguments") ||
      !model || node.model && model !== node.model || !Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(startedAt + node.maxWallTimeMs))
    throw new Error("Protected agent requires its original exact action, model and start time");
  if (modelInputItemCount(node.input, point.arguments) > node.maxInputItems || [...JSON.stringify(point.arguments)].length > node.maxInputChars) exhausted();
  return { profile: "protected-agent-invocation/v2", invocationId: point.invocationId, nodeId: point.nodeId, sequence: point.sequence,
    pointHash: hash(point), inputHash: hash(point.arguments), nodeHash: hash(node), model, startedAt, deadline: startedAt + node.maxWallTimeMs, turnCount: 0, resultCount: 0,
    offers: offered(context).map(item => structuredClone(item.tool)) };
}

function offered(context: Context) {
  const result = context.node.allowedCapabilities.map(capability => {
    const tools = context.tools.filter(tool => tool.tool_id === capability.toolId && tool.name === capability.action && tool.is_read_only &&
      exactBridgeName(tool) === capability.remoteName && capabilityContractHash(tool) === capability.contractHash && capability.admission.contractHash === capability.contractHash);
    if (tools.length !== 1) denied("Protected agent allowed capability contract is unavailable or changed");
    return { capability, tool: tools[0]! };
  });
  if (new Set(result.map(item => item.capability.remoteName)).size !== result.length) denied("Protected agent remote names are ambiguous");
  return result;
}

/** Validate a genuine turn BEFORE an owned worker records its acknowledgement.
 * Pure validation does not establish provider provenance or a storage commit. */
export function protectedAgentTurnOutput(node: OperationAgentNode, model: string, turn: QueryTurnResult | ProtectedAgentTurn["turn"], usedTokens: number): unknown {
  assertBoundedFiniteJSON(turn, 1_000_000);
  if (turn.measured !== true) throw new RuntimeAgentKnownFailure("AGENT_USAGE_UNMEASURED", "Protected agent needs measured provider usage");
  if (!Number.isSafeInteger(turn.inputTokens) || turn.inputTokens < 0 || !Number.isSafeInteger(turn.outputTokens) || turn.outputTokens < 0 ||
      !Number.isSafeInteger(usedTokens) || usedTokens < 0 || !Number.isSafeInteger(usedTokens + turn.inputTokens + turn.outputTokens) ||
      usedTokens + turn.inputTokens + turn.outputTokens > node.maxTotalTokens || turn.outputTokens > Math.min(node.maxOutputTokens, node.maxTotalTokens - usedTokens)) exhausted();
  if (turn.model !== undefined && turn.model !== model || typeof turn.text !== "string" || !Array.isArray(turn.toolCalls) || turn.toolCalls.length > 16) invalid("Protected agent model/response contract changed");
  if (turn.providerContinuationSecret) {
    assertProviderContinuation(turn.providerContinuationSecret);
    if (!turn.toolCalls.length || turn.providerContinuationSecret.model !== model) invalid("Protected agent continuation has a different model or no tool round");
  }
  if (turn.toolCalls.length) {
    if (turn.stopReason !== "tool_calls") invalid("Protected agent tool calls have no complete tool-call stop reason");
    return structuredClone(turn);
  }
  if (turn.stopReason !== "stop" || !turn.text.trim()) invalid("Protected agent has no complete final response");
  let decoded: unknown;
  try { decoded = JSON.parse(turn.text); } catch { invalid("Protected agent final response is not valid JSON"); }
  const safe = withoutSecretFields(decoded);
  if (!safe || typeof safe !== "object" || Array.isArray(safe) || validateValue(node.outputSchema, safe).length || canonicalJSONBytes(safe).length > 1_000_000)
    invalid("Protected agent final response does not satisfy its output schema");
  let selected: unknown = safe;
  for (const part of node.completionPredicate.path) {
    if (!selected || typeof selected !== "object" || Array.isArray(selected) || !Object.hasOwn(selected, part))
      throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Protected agent completion predicate is unmet");
    selected = (selected as Record<string, unknown>)[part];
  }
  if (!Object.is(selected, node.completionPredicate.equals)) throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Protected agent completion predicate is unmet");
  return { structuredContent: safe };
}

/** Deterministically reconstruct the next sub-call from original compiled
 * input and all acknowledged private artifacts. No network, storage mutation,
 * model fallback, permission or automatic retry exists in this protocol. */
export function nextProtectedAgent(context: Context, records: ProtectedAgentRecords, ledger: ProtectedInvocationLedgerSnapshot, now: number) {
  assertProtectedAgentRecords(records, ledger);
  const saved = records.invocations[context.point.invocationId];
  if (!saved) throw new Error("Protected agent invocation has not been durably initialized");
  const initial = protectedAgentProgress(context, saved.startedAt);
  const { turnCount: _turns, resultCount: _results, ...expected } = initial;
  const { turnCount: _savedTurns, resultCount: _savedResults, ...actual } = saved;
  const original = saved.profile === "protected-agent-invocation/v1" ? (() => {
    const { offers: _offers, ...v1 } = expected; return { ...v1, profile: "protected-agent-invocation/v1" };
  })() : expected;
  if (hash(original) !== hash(actual) || !Number.isSafeInteger(now) || now < saved.startedAt) throw new Error("Protected agent original input, node, point, model or time binding changed");
  const capabilities = offered(context), definitions: QueryToolDefinition[] = capabilities.map(({ capability, tool }) => ({ type: "function", function: {
    name: capability.remoteName, description: tool.description, parameters: structuredClone(tool.input_schema) } }));
  const messages: QueryMessage[] = [{ role: "system", content: RUNTIME_AGENT_SYSTEM_PROMPT }, { role: "user", content: dataMessage({
    TASK: context.node.instruction, INPUT: context.point.arguments, OUTPUT_SCHEMA: context.node.outputSchema, COMPLETION_PREDICATE: context.node.completionPredicate }) }];
  let inputTokens = 0, outputTokens = 0, toolCalls = 0;
  const seenCalls = new Set<string>(), seenIds = new Set<string>(), consumed = new Set<string>();
  const keyFor = (component: Parameters<typeof protectedInvocationOperationKey>[2]) => protectedInvocationOperationKey(ledger.identity, saved.invocationId, component);
  const finish = <T>(result: T) => {
    const entries = Object.values(ledger.intents).filter(item => item.sequence === saved.sequence);
    if (entries.some(item => !consumed.has(item.key)) || Object.entries(records.turns).some(([key, row]) => row.invocationId === saved.invocationId && !consumed.has(key)) ||
        Object.entries(records.results).some(([key, row]) => row.invocationId === saved.invocationId && !consumed.has(key))) throw new Error("Protected agent has out-of-order or foreign dialogue artifacts");
    return result;
  };
  const pending = (key: string, args: unknown) => {
    const intent = ledger.intents[key];
    if (!intent) return undefined;
    consumed.add(key);
    if (intent.argumentHash !== hash(args) || intent.sequence !== saved.sequence || intent.boundary.invocationId !== saved.invocationId || intent.boundary.nodeId !== saved.nodeId)
      throw new Error("Protected agent prepared sub-call differs from reconstructed arguments");
    if (intent.state === "DISPATCH_INTENT" || intent.state === "UNKNOWN") return finish({ kind: "RECOVERY_REQUIRED" as const, key });
    if (intent.state === "ACKNOWLEDGED") throw new Error("Protected agent acknowledged sub-call lacks its saved artifact");
    return undefined;
  };
  const budget = () => { if (now >= saved.deadline || inputTokens + outputTokens >= context.node.maxTotalTokens) exhausted(); };
  for (let round = 0; round < context.node.maxRounds; round++) {
    const component = { kind: "agent-model" as const, round }, key = keyFor(component);
    const args = { profile: "protected-agent-model-input/v1", messages: structuredClone(messages), definitions, model: saved.model,
      maxOutputTokens: Math.min(context.node.maxOutputTokens, context.node.maxTotalTokens - inputTokens - outputTokens), promptTemplateVersion: RUNTIME_AGENT_PROMPT_VERSION };
    const row = records.turns[key];
    if (!row) {
      const recovery = pending(key, args); if (recovery) return recovery;
      budget(); return finish({ kind: "MODEL" as const, key, component, arguments: args, inputTokens, outputTokens, toolCalls, deadline: saved.deadline });
    }
    consumed.add(key);
    if (row.round !== round || ledger.intents[key]?.argumentHash !== hash(args)) throw new Error("Protected agent turn differs from original ordered model input");
    const output = protectedAgentTurnOutput(context.node, saved.model, row.turn, inputTokens + outputTokens);
    if (ledger.intents[key]?.result?.hash !== hash(output)) throw new Error("Protected agent turn differs from acknowledged model output");
    inputTokens += row.turn.inputTokens; outputTokens += row.turn.outputTokens;
    if (!row.turn.toolCalls.length) return finish({ kind: "COMPLETE" as const, output, inputTokens, outputTokens, toolCalls, rounds: round + 1 });
    if (toolCalls + row.turn.toolCalls.length > context.node.maxToolCalls || round + 1 >= context.node.maxRounds) exhausted();
    // Validate the entire offered batch before any member may enter the SDK.
    // A bad later proposal must not poison a confirmed history after a valid
    // earlier read, or allow a partial batch to masquerade as resumable work.
    const validated = row.turn.toolCalls.map(call => {
      const matches = capabilities.filter(item => item.capability.remoteName === call.name);
      if (matches.length !== 1 || !call.id || seenIds.has(call.id)) denied("Protected agent proposed an unavailable tool or reused call identifier");
      const match = matches[0]!, callHash = hash({ toolId: match.capability.toolId, arguments: call.arguments });
      const validation = validateToolArguments(match.capability.action, call.arguments, match.tool);
      if (seenCalls.has(callHash) || validateToolInput(match.tool.input_schema, call.arguments).length || validation.missing.length || validation.invalid.length ||
          hasReservedBridgeRole(match.tool) && Object.hasOwn(call.arguments, "role")) denied("Protected agent repeated a call or proposed invalid/reserved arguments");
      seenCalls.add(callHash); seenIds.add(call.id); return match;
    });
    messages.push(assistantToolCallMessage(row.turn, args => canonicalJSONBytes(args).toString("utf8")));
    for (const [callIndex, call] of row.turn.toolCalls.entries()) {
      const { capability, tool } = validated[callIndex]!;
      const toolComponent = { kind: "agent-tool" as const, round, callIndex }, toolKey = keyFor(toolComponent), result = records.results[toolKey];
      if (!result) {
        const recovery = pending(toolKey, call.arguments); if (recovery) return recovery;
        budget(); return finish({ kind: "TOOL" as const, key: toolKey, component: toolComponent, arguments: structuredClone(call.arguments),
          call: structuredClone(call), capability: structuredClone(capability), tool: structuredClone(tool), inputTokens, outputTokens, toolCalls, deadline: saved.deadline });
      }
      consumed.add(toolKey);
      if (result.round !== round || result.callIndex !== callIndex || ledger.intents[toolKey]?.argumentHash !== hash(call.arguments))
        throw new Error("Protected agent tool answer belongs to different ordered arguments");
      if (result.result.kind === "READ_ERROR") return finish({ kind: "READ_ERROR" as const, key: toolKey, fault: structuredClone(result.result.fault) });
      const safe = safeMcpToolResult(result.result.output, tool);
      const metadata = result.result.output._meta as Record<string, unknown> | undefined, dispatch = metadata?.["io.workflow-engine/dispatch"];
      if (dispatch !== undefined) {
        const expected = { remoteName: exactBridgeName(tool), resourceVersion: tool.bridge_contract!.resource_version, resourceDigest: tool.bridge_contract!.resource_digest };
        if (hash(dispatch) !== hash(expected)) invalid("Protected agent local request provenance differs from its original tool");
        safe._meta = { ...(safe._meta as Record<string, unknown> | undefined), "io.workflow-engine/dispatch": expected };
      }
      if (safe.isError || hash(safe) !== hash(result.result.output)) invalid("Protected agent tool answer is not a confirmed sanitized success");
      toolCalls++;
      messages.push({ role: "tool", tool_call_id: call.id, content: dataMessage({ source: "untrusted_tool_result", callId: call.id,
        toolName: capability.action, status: "SUCCEEDED", data: mcpResultForModel(safe) }) });
    }
  }
  return exhausted();
}

/** Historical replay uses captured original offers, not currently granted
 * tools. Revocation must still allow an authentic old worker to stop safely;
 * current dispatch authority is established separately by its controller. */
export function assertProtectedAgentHistory(plan: CompiledProtectedOperationPlan, run: Execution): void {
  const records = run.protectedAgentSecret, ledger = run.protectedInvocationSecret!;
  if (!records) {
    if (Object.values(ledger.intents).some(item => item.purpose === "agent-model" || item.purpose === "agent-tool")) throw new Error("Owned agent run lacks saved dialogue");
    return;
  }
  if (records.profile !== "protected-agent-records/v2") throw new Error("Owned agent execution requires captured-offer dialogue v2");
  const bySequence = new Map(Object.values(records.invocations).map(item => [item.sequence, item]));
  const replay = new ProtectedMachine(plan.machine, run.workflowSnapshot!.input); replay.peek();
  for (let at = 0; at <= ledger.nextSequence; at++) {
    const saved = bySequence.get(at), point = replay.peek();
    if (saved) {
      const node = plan.ir.root.nodes.find(item => item.id === saved.nodeId);
      if (!point || node?.kind !== "agent") throw new Error("Saved agent dialogue belongs to a non-agent authored boundary");
      const next = nextProtectedAgent({ node, point, model: saved.model, tools: saved.offers }, records, ledger, saved.startedAt);
      if (at < ledger.nextSequence) {
        const receipt = ledger.receipts[String(at)]!;
        if (next.kind === "COMPLETE" ? receipt.result.kind !== "accept" || hash(receipt.result.output) !== hash(next.output) :
            next.kind === "READ_ERROR" ? receipt.result.kind !== "business-read-failure" || receipt.result.intentKey !== next.key || hash(receipt.result.fault) !== hash(next.fault) : true)
          throw new Error("Consumed agent boundary differs from its complete saved dialogue");
      }
    }
    if (at < ledger.nextSequence) {
      const result = ledger.receipts[String(at)]!.result;
      if (result.kind === "accept") replay.accept(result.output); else replay.fail(result.fault);
      replay.peek();
    }
  }
}
