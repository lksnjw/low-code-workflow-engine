import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { assertReadContinuation, type Execution, type Repository, type RepositoryState, type ReadRunAttempt } from "../repository/store.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { canonicalJSONByteLength, JSONProofCache } from "../core/json-proof-cache.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { type ReadVisit } from "../workflows/read-interpreter.js";
import { ReadMachine } from "../workflows/read-machine.js";
import { ReadContinuationCodec } from "./read-continuation.js";
import { ReadCompletionEvidence, type CompletedRead } from "../workflows/read-completion-evidence.js";
import { assertCompiledReadMatches, compileReadWorkflow, type CompiledReadPlan, type ReadAdmissionPin } from "../workflows/compiled-read.js";
import { loopNodes, structuralNodes, type ReadSkipReason } from "../workflows/read-control-flow.js";
import { ReadValueBudget } from "../workflows/read-value-budget.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { safeMcpToolResult } from "../tools/mcp-result.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { appendExecutionEvent, assertCurrentRunController, ReadCheckpointFailure, ReadRunCancelled } from "./read-checkpoints.js";
import { connectionToolKey } from "../tools/mcp-dispatch-context.js";

export type IterationReceipt = {
  nodeId: string; invocationId: string; iterations: ReadVisit["iterations"]; sourceIndex: number;
  kind: "action" | "condition" | "merge" | "return" | "collection-item" | "collection";
  status: "PREPARING" | "DISPATCH_INTENT" | "STARTED" | "DONE" | "FAILED" | "UNKNOWN" | "CANCELLED" | "SKIPPED" | "INTERRUPTED";
  recordedAt: string; seal: string; attemptId?: string; count?: number; selected?: "then" | "else";
  reason?: ReadSkipReason; dataBinding?: string; outputBinding?: string; completionIndex?: number;
};
export type ReadIterationLedger = { profile: "read-iterations/v1"; sourceHash: string; semanticHash: string; inputBinding: string; admittedRole: string; receipts: Record<string, IterationReceipt>; interruptedAt?: string; recoveryReason?: string };
export type IterationBoundary = {
  kind: IterationReceipt["kind"] | "skip"; nodeId: string; sourceIndex: number; visit: ReadVisit;
  valid: boolean; arguments?: Record<string, unknown>; value?: unknown; selected?: "then" | "else";
  count?: number; reason?: ReadSkipReason; phase?: "start" | "complete"; dataBinding?: string;
};
export type ReadSelectedEvidence = {
  profile: "read-selected-evidence/v1"; executionId: string; epoch: number; inputBinding: string;
  sourceHash: string; semanticHash: string; actorId: string; admittedRole: string;
  nodeId: string; sourceIndex: number; attemptId: string; visit: ReadVisit;
  args: Record<string, unknown>; prior: readonly CompletedRead[];
};
type BoundExecution = Execution & { readProgress: NonNullable<Execution["readProgress"]>; iterationProgress: ReadIterationLedger };
class StoppedBoundary extends Error { constructor(readonly receipt: IterationReceipt) { super("Iteration has a stopped or uncertain receipt; no replay is authorized"); } }
type WorkingContinuation = { machine: ReadMachine; completion: ReadCompletionEvidence; used: Set<string>; hasFinal: boolean; observedFinal?: unknown };
const same = (left: unknown, right: unknown) => canonicalJSONBytes(left).equals(canonicalJSONBytes(right));
const receiptKey = (kind: IterationBoundary["kind"], address: string) => `${kind === "skip" ? "action" : kind}:${address}`;
function digest(key: string, value: unknown): string {
  if (Buffer.byteLength(key) < 32) throw new Error("Iteration evidence requires a server-held binding key of at least 32 bytes");
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalJSONBytes(value)).digest("hex")}`;
}
function privateInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("Iteration input must be a JSON object");
  const value = new ReadValueBudget().clone(input, 0) as Record<string, unknown>;
  if (canonicalJSONBytes(value).length > 64_000) throw new Error("Private iteration input exceeds 64 KB");
  return value;
}
const inputDigest = (key: string, executionId: string, plan: CompiledReadPlan, input: Record<string, unknown>, role: string) => digest(key, { profile: "read-iterations/v1", executionId, sourceHash: plan.sourceHash, semanticHash: plan.semanticHash, role, input });
export function newReadIterationLedger(executionId: string, plan: CompiledReadPlan, input: Record<string, unknown>, role: string, bindingKey: string): ReadIterationLedger {
  if (plan.ir.schemaVersion !== "workflow-read-ir/v4" || !plan.ir.flow || !loopNodes(plan.ir.flow).length) throw new Error("Iteration receipts require a compiled collection plan");
  const bounded = privateInput(input);
  if (plan.ir.inputSchema && validateToolInput(plan.ir.inputSchema, bounded).length) throw new Error("Iteration input does not match its compiled contract");
  return { profile: "read-iterations/v1", sourceHash: plan.sourceHash, semanticHash: plan.semanticHash, inputBinding: inputDigest(bindingKey, executionId, plan, bounded, role), admittedRole: role, receipts: {} };
}

/** Server-only journal foundation. It has no SDK, provider, live admission or
 * network authority. v4 normal admission stays fenced pending publication and
 * fenced worker/private-input lifecycle qualification through the driver.
 * Private encrypted continuations advance pure semantics only after confirmed
 * receipts. Restore is bound to the exact run/epoch/input and complete saved
 * evidence; no caller-supplied cursor/branch/collection value is trusted. */
export class ReadIterationCheckpoints {
  readonly #plan: CompiledReadPlan;
  readonly #input: Record<string, unknown>;
  readonly #tools: readonly ToolDefinition[];
  readonly #bindingKey: string;
  readonly #sourceHash: string;
  readonly #capturedYaml: string;
  readonly #loops: Map<string, ReturnType<typeof loopNodes>[number]>;
  readonly #valueNodes: Map<string, ReturnType<typeof structuralNodes>[number]>;
  #validatedPlanRole: string | undefined;
  readonly #receiptProofs = new JSONProofCache<true>(1_000_000, 5000);
  readonly #valueBindings = new JSONProofCache<string>();
  readonly #continuationLeaves = new JSONProofCache<string>(4_000_000, 5000);
  readonly #continuationIdentities = new JSONProofCache<string>(200_000, 2);
  readonly #continuationCodec: ReadContinuationCodec;
  #transaction: { state: RepositoryState; working: WorkingContinuation } | undefined;
  #warmContinuation: { ciphertext: string; identity: string; evidenceBinding: string; working: WorkingContinuation } | undefined;
  constructor(readonly repository: Repository, readonly executionId: string, readonly epoch: number, readonly yaml: string,
    plan: CompiledReadPlan, input: Record<string, unknown>, tools: readonly ToolDefinition[], bindingKey: string, readonly signal?: AbortSignal) {
    this.#plan = structuredClone(plan); this.#input = privateInput(input); this.#tools = structuredClone(tools); this.#bindingKey = bindingKey;
    this.#capturedYaml = yaml; this.#sourceHash = workflowContentHash(yaml);
    this.#loops = new Map(this.#plan.ir.flow ? loopNodes(this.#plan.ir.flow).map(node => [node.id, node]) : []);
    this.#valueNodes = new Map(this.#plan.ir.flow ? structuralNodes(this.#plan.ir.flow).map(node => [node.id, node]) : []);
    this.#continuationCodec = new ReadContinuationCodec(bindingKey);
  }
  private current(state: RepositoryState): BoundExecution {
    const item = state.executions[this.executionId], ledger = item?.iterationProgress;
    if (this.yaml !== this.#capturedYaml || !item || item.status !== "RUNNING" || !item.readProgress || item.readProgress.profile !== "read-progress-v1" || item.readProgress.epoch !== this.epoch ||
        item.workflowSnapshot?.yaml !== this.yaml || item.workflowSnapshot.executionProfile !== "collection-read-v1" || item.workflowSnapshot.contentHash !== this.#sourceHash || item.workflowSnapshot.compilation?.schemaVersion !== "workflow-read-ir/v4" ||
        item.workflowSnapshot.compilation.semanticHash !== this.#plan.semanticHash || !ledger || ledger.profile !== "read-iterations/v1" || ledger.sourceHash !== this.#plan.sourceHash || ledger.semanticHash !== this.#plan.semanticHash ||
        ledger.interruptedAt || ledger.recoveryReason || this.#plan.ir.schemaVersion !== "workflow-read-ir/v4" || !this.#plan.ir.flow || !this.#loops.size || this.#plan.sourceHash !== this.#sourceHash ||
        ledger.inputBinding !== inputDigest(this.#bindingKey, item.id, this.#plan, this.#input, ledger.admittedRole))
      throw new Error("Iteration worker identity, epoch, source or private input changed");
    // These projections are private cloned immutable inputs. Validate once per
    // captured role; volatile execution/authority/evidence is checked every time.
    if (this.#validatedPlanRole !== ledger.admittedRole) {
      const source = parseWorkflowYAMLStrict(this.yaml), pins = new Map<string, ReadAdmissionPin>();
      this.#plan.ir.root.nodes.forEach((node, index) => { const pin = node.capability.admission; if (!pin) return;
        pins.set(connectionToolKey(pin.connectionId, node.capability.toolId), pin); if (!source.steps[index]?.connection_id) pins.set(node.capability.toolId, pin); });
      assertCompiledReadMatches(this.#plan, compileReadWorkflow(this.yaml, this.#tools, ledger.admittedRole, pins)); this.#validatedPlanRole = ledger.admittedRole;
    }
    if (Object.keys(ledger.receipts).length > 5000 || canonicalJSONByteLength(ledger) > 1_000_000) throw new Error("Iteration journal exceeds bounded limits");
    for (const [address, receipt] of Object.entries(ledger.receipts)) {
      const witness = { inputBinding: ledger.inputBinding, address, receipt };
      this.#receiptProofs.getOrCompute(witness, () => {
        const { seal, ...record } = receipt;
        const expected = this.receiptSeal(ledger, record);
        if (address !== receiptKey(receipt.kind, receipt.invocationId) || typeof seal !== "string" || Buffer.byteLength(seal) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(seal), Buffer.from(expected))) throw new Error("Iteration receipt is not authentic for this run");
        return true;
      });
    }
    const actionOutputs = new Set<string>(), valueOutputs = new Set<string>();
    const actionReceipts = Object.values(ledger.receipts).filter(receipt => receipt.kind === "action");
    if (Object.keys(item.readProgress.attempts).length !== actionReceipts.length) throw new Error("Unexpected or missing iteration attempts");
    for (const receipt of actionReceipts) {
      const attempt = item.readProgress.attempts[receipt.invocationId];
      if (!attempt || attempt.id !== receipt.attemptId || attempt.nodeId !== receipt.nodeId || attempt.invocationId !== receipt.invocationId || attempt.stepIndex !== receipt.sourceIndex || attempt.status !== receipt.status || !same(attempt.iterations, receipt.iterations)) throw new Error("Iteration receipt differs from its exact saved attempt");
    }
    for (const receipt of Object.values(ledger.receipts)) if (receipt.status === "DONE" && receipt.kind !== "condition") {
      this.output(item as BoundExecution, receipt);
      (receipt.kind === "action" ? actionOutputs : valueOutputs).add(receipt.invocationId);
    }
    if (Object.keys(item.stepOutputs ?? {}).some(id => !actionOutputs.has(id)) || Object.keys(item.valueOutputs ?? {}).some(id => !valueOutputs.has(id))) throw new Error("Unexpected iteration output outside authenticated receipts");
    return item as BoundExecution;
  }
  private receiptSeal(ledger: ReadIterationLedger, value: Omit<IterationReceipt, "seal">): string {
    return digest(this.#bindingKey, { executionId: this.executionId, inputBinding: ledger.inputBinding, receipt: value });
  }
  private outputBinding(value: unknown): string {
    const witness = { executionId: this.executionId, output: value };
    return this.#valueBindings.getOrCompute(witness, () => digest(this.#bindingKey, witness));
  }
  private put(item: BoundExecution, receipt: Omit<IterationReceipt, "seal">): void { item.iterationProgress.receipts[receiptKey(receipt.kind, receipt.invocationId)] = { ...receipt, seal: this.receiptSeal(item.iterationProgress, receipt) }; }
  private assertAuthority(state: RepositoryState, item: BoundExecution): void {
    if (item.readProgress.cancellation || this.signal?.aborted) throw new ReadRunCancelled();
    assertCurrentRunController(state, item, item.startedBy.id, item.iterationProgress.admittedRole);
  }
  private output(item: BoundExecution, receipt: IterationReceipt): unknown {
    const raw = receipt.kind === "action" ? item.stepOutputs?.[receipt.invocationId] : item.valueOutputs?.[receipt.invocationId];
    if (raw === undefined || receipt.outputBinding !== this.outputBinding(raw)) throw new Error("Iteration receipt lacks its authentic saved output");
    return raw;
  }
  private pendingWitness(item: BoundExecution, journal: RepositoryState): unknown {
    const leaf = (section: string, value: unknown) => {
      const witness = { profile: "read-continuation-leaf/v1", executionId: item.id, section, value };
      return this.#continuationLeaves.getOrCompute(witness, () => digest(this.#bindingKey, witness));
    };
    const entries = (value: Record<string, unknown>, proof: (value: unknown) => string) => Object.keys(value).sort().map(key => [key, proof(value[key])]);
    // current() has already freshly authenticated every receipt, exact attempt
    // and saved output. Bind their complete identities through authenticated
    // leaves instead of repeatedly canonicalizing the entire growing output
    // tree. Ordered timeline/attempt leaves still bind every stored field.
    return { profile: "read-continuation-evidence/v1", inputBinding: item.iterationProgress.inputBinding,
      receipts: Object.keys(item.iterationProgress.receipts).sort().map(key => [key, item.iterationProgress.receipts[key]!.seal]),
      attempts: entries(item.readProgress.attempts, value => leaf("attempt", value)),
      stepOutputs: entries(item.stepOutputs ?? {}, value => this.outputBinding(value)), valueOutputs: entries(item.valueOutputs ?? {}, value => this.outputBinding(value)),
      hasFinalOutput: Object.hasOwn(item, "finalOutput"), ...(Object.hasOwn(item, "finalOutput") ? { finalOutput: this.outputBinding(item.finalOutput) } : {}),
      timeline: (journal.timelines[item.id] ?? []).map(value => leaf("timeline", value)) };
  }
  private continuationIdentity(item: BoundExecution): string {
    const witness = { profile: "private-read-continuation/v1", executionId: item.id, epoch: this.epoch,
      workflowId: item.workflowId, actorId: item.startedBy.id, inputBinding: item.iterationProgress.inputBinding,
      admittedRole: item.iterationProgress.admittedRole, snapshot: item.workflowSnapshot };
    return this.#continuationIdentities.getOrCompute(witness, () => digest(this.#bindingKey, witness));
  }
  private continuationBinding(item: BoundExecution, journal: RepositoryState): string {
    const witness = this.pendingWitness(item, journal);
    return digest(this.#bindingKey, witness);
  }
  private restoreContinuation(item: BoundExecution, journal: RepositoryState): WorkingContinuation {
    const record = journal.readContinuations[item.id];
    // Legacy runs without a cursor are reconstructed solely from confirmed
    // receipts below. This performs zero SDK/model work and never replays it.
    if (!Object.hasOwn(journal.readContinuations, item.id)) return { machine: new ReadMachine(this.#plan, this.#input), completion: new ReadCompletionEvidence(this.#plan), used: new Set(), hasFinal: false };
    assertReadContinuation(record, item.id);
    const identity = this.continuationIdentity(item), evidenceBinding = this.continuationBinding(item, journal);
    const warm = this.#warmContinuation;
    // One bounded private decoded continuation. The exact ciphertext and
    // freshly computed complete evidence binding must match; current() and
    // authority/cancellation checks remain outside and cannot be memoized.
    if (warm && record.profile === "read-continuation/v1" && record.executionId === item.id && Object.keys(record).length === 3 && warm.ciphertext === record.ciphertext && warm.identity === identity && warm.evidenceBinding === evidenceBinding) {
      return { machine: warm.working.machine.fork(), completion: warm.working.completion.fork(), used: new Set(warm.working.used), hasFinal: warm.working.hasFinal,
        ...(warm.working.hasFinal ? { observedFinal: structuredClone(warm.working.observedFinal) } : {}) };
    }
    const body = this.#continuationCodec.decode(record, item.id, identity, evidenceBinding);
    if (body.used.some(key => !Object.hasOwn(item.iterationProgress.receipts, key))) throw new Error("Continuation refers to missing committed evidence");
    return { machine: new ReadMachine(this.#plan, {}, body.machine), completion: new ReadCompletionEvidence(this.#plan, body.completion),
      used: new Set(body.used), hasFinal: body.hasFinal, ...(body.hasFinal ? { observedFinal: body.observedFinal } : {}) };
  }
  private saveContinuation(item: BoundExecution, journal: RepositoryState, working: WorkingContinuation): void {
    if (item.status !== "RUNNING") { delete journal.readContinuations[item.id]; this.#warmContinuation = undefined; return; }
    const identity = this.continuationIdentity(item), evidenceBinding = this.continuationBinding(item, journal);
    const record = this.#continuationCodec.encode(item.id, { profile: "private-read-continuation/v1", identity,
      evidenceBinding, machine: working.machine.snapshot(), completion: working.completion.snapshot(),
      used: [...working.used], hasFinal: working.hasFinal, ...(working.hasFinal ? { observedFinal: working.observedFinal } : {}) });
    journal.readContinuations[item.id] = record; this.#warmContinuation = { ciphertext: record.ciphertext, identity, evidenceBinding, working };
  }
  private async next(item: BoundExecution, journal: RepositoryState, selected?: { prior: readonly CompletedRead[] }): Promise<IterationBoundary | null> {
    const working = this.#transaction?.state === journal ? this.#transaction.working : this.restoreContinuation(item, journal);
    const { machine, completion, used } = working;
    // Index this fresh transaction's timeline, not a cached authoritative
    // snapshot. Multiple witnesses for one boundary are ambiguous evidence.
    const timelines = new Map<string, RepositoryState["timelines"][string][number]>();
    for (const entry of journal.timelines[item.id] ?? []) if (typeof entry.boundaryKey === "string") {
      if (timelines.has(entry.boundaryKey)) throw new Error("Duplicate iteration timeline boundary");
      timelines.set(entry.boundaryKey, entry);
    }
    const assertFinal = () => { if (working.hasFinal !== Object.hasOwn(item, "finalOutput") || working.hasFinal && !same(working.observedFinal, item.finalOutput)) throw new Error("Final answer differs from its last confirmed action or workflow return"); };
    const timeline = (receipt: IterationReceipt) => {
      const entry = timelines.get(receiptKey(receipt.kind, receipt.invocationId));
      if (entry && (entry.nodeId !== receipt.nodeId || entry.invocationId !== receipt.invocationId || !same(entry.iterations, receipt.iterations) || receipt.attemptId && entry.attemptId !== receipt.attemptId)) throw new Error("Iteration timeline identity differs from its authenticated receipt");
      return entry;
    };
    const receiptFor = (point: IterationBoundary): IterationReceipt | undefined => {
      const key = receiptKey(point.kind, point.visit.invocationId), receipt = item.iterationProgress.receipts[key];
      if (!receipt) return undefined;
      used.add(key);
      const indexMatches = point.kind === "collection" && point.phase === "complete" ? receipt.status === "STARTED" || receipt.completionIndex === point.sourceIndex : receipt.sourceIndex === point.sourceIndex;
      if (receipt.nodeId !== point.nodeId || !indexMatches || !same(receipt.iterations, point.visit.iterations) || receipt.kind !== (point.kind === "skip" ? "action" : point.kind)) throw new Error("Iteration receipt is outside the computed boundary");
      if (["FAILED", "UNKNOWN", "CANCELLED", "INTERRUPTED"].includes(receipt.status)) throw new StoppedBoundary(receipt);
      return receipt;
    };
    const pending = (point: IterationBoundary | null): IterationBoundary | null => {
      // Extra authenticated-but-out-of-order receipts cannot authorize jumping
      // across an earlier missing boundary, even if their output is present.
      if (Object.keys(item.iterationProgress.receipts).some(id => !used.has(id))) throw new Error("Iteration receipts precede an unconfirmed earlier boundary");
      assertFinal();
      return point;
    };
    for (let boundaries = 0; boundaries <= 5000; boundaries++) {
      const raw = machine.peek(); if (!raw) return pending(null);
      const point: IterationBoundary = structuredClone(raw); let safe: { value: unknown } | undefined;
      if (point.kind === "action") {
        const node = this.#plan.ir.root.nodes[point.sourceIndex]!, tool = this.#tools.find(value => value.tool_id === node.capability.toolId)!;
        point.valid = !!point.arguments && !validateToolInput(tool.input_schema, point.arguments).length;
        if (point.arguments) point.dataBinding = this.outputBinding(point.arguments);
        if (selected) selected.prior = completion.prior(point.nodeId, point.visit);
      } else if (point.kind === "collection" && point.phase === "start") {
        if (point.valid) point.dataBinding = this.outputBinding(point.value); delete point.value;
      } else if (["merge", "return", "collection-item", "collection"].includes(point.kind)) {
        safe = point.valid ? withoutSecretFields({ value: point.value }) as { value: unknown } : undefined;
        const node = this.#valueNodes.get(point.nodeId)!;
        if (node.kind === "protect") throw new Error("Protected scopes require durable handler checkpoints");
        const schema = node.kind === "return" ? node.output.schema : node.kind === "if" ? node.merge?.schema : point.kind === "collection" ? { type: "array", items: node.collect.schema } : node.collect.schema;
        point.valid = !!safe && !!schema && !validateToolInput(schema, safe.value).length;
        if (safe) point.value = safe.value; else delete point.value;
      }
      const receipt = receiptFor(point); if (!receipt) return pending(point);
      if (point.kind === "action") {
        if (receipt.dataBinding !== point.dataBinding) throw new Error("Saved iteration arguments no longer match their exact binding");
        if (["PREPARING", "DISPATCH_INTENT"].includes(receipt.status)) return pending(point);
        if (receipt.status !== "DONE" || !point.valid) throw new Error("Action receipt is not a confirmed valid invocation");
        const output = this.output(item, receipt) as Record<string, unknown>, entry = timeline(receipt);
        if (!entry || entry.status !== "DONE" || this.outputBinding(entry.output) !== receipt.outputBinding || output.isError === true) throw new Error("Iteration answer lacks a matching confirmed success timeline receipt");
        completion.actionCompleted(point.nodeId, point.arguments!, point.visit); working.observedFinal = output; working.hasFinal = true; machine.accept(output);
      } else if (point.kind === "condition") {
        if (receipt.status !== "DONE" || !point.valid || receipt.selected !== point.selected) throw new Error("Condition receipt differs from its computed predicate");
        const entry = timeline(receipt); if (!entry || entry.status !== "DONE" || entry.selectedBranch !== point.selected) throw new Error("Condition lacks its matching decision timeline"); machine.accept();
      } else if (point.kind === "skip") {
        if (receipt.status !== "SKIPPED" || !same(receipt.reason, point.reason) || Object.hasOwn(item.stepOutputs ?? {}, point.visit.invocationId)) throw new Error("Skip lacks exact reason or invents an answer");
        const entry = timeline(receipt); if (!entry || entry.status !== "SKIPPED" || !same(entry.reason, point.reason)) throw new Error("Skip lacks its matching declaration timeline"); machine.accept();
      } else if (point.kind === "collection" && point.phase === "start") {
        if (!point.valid || !["STARTED", "DONE"].includes(receipt.status) || receipt.count !== point.count || receipt.dataBinding !== point.dataBinding) throw new Error("Collection input identity or count differs from the committed start");
        completion.collectionStarted(point.nodeId, point.count!, point.visit); machine.accept();
      } else {
        if (point.kind === "collection" && receipt.status === "STARTED") return pending(point);
        if (receipt.status !== "DONE" || !point.valid || !same(this.output(item, receipt), safe)) throw new Error("Typed receipt differs from its computed scoped value");
        const entry = timeline(receipt); if (!entry || entry.status !== "DONE" || !same(entry.output, safe)) throw new Error("Typed value lacks its matching saved timeline");
        if (point.kind === "collection-item") completion.itemCompleted(point.nodeId, point.visit);
        if (point.kind === "collection") completion.collectionCompleted(point.nodeId, point.visit);
        if (point.kind === "return") { working.observedFinal = safe!.value; working.hasFinal = true; }
        machine.accept(safe);
      }
    }
    throw new Error("Incremental read traversal exceeds bounded receipt limits");
  }
  private async commit<T>(mutation: (state: RepositoryState, item: BoundExecution) => Promise<T> | T): Promise<T> {
    try { return await this.repository.mutateExecution(this.executionId, async state => { const item = this.current(state), working = this.restoreContinuation(item, state);
      this.#transaction = { state, working }; let result: T;
      try { result = await mutation(state, item); } finally { this.#transaction = undefined; }
      if (canonicalJSONByteLength({ ledger: item.iterationProgress, outputs: item.stepOutputs ?? {}, values: item.valueOutputs ?? {} }) > 2_000_000) throw new Error("Iteration evidence exceeds aggregate storage limits");
      this.saveContinuation(item, state, working);
      return result;
    }); } catch (cause) { this.#warmContinuation = undefined; if (cause instanceof ReadRunCancelled) throw cause; throw new ReadCheckpointFailure(cause); }
  }
  private emit(state: RepositoryState, item: BoundExecution, type: string, point: IterationBoundary, attemptId?: string): void {
    appendExecutionEvent(state, item, type, { invocationId: point.visit.invocationId, iterations: point.visit.iterations, sourceIndex: point.sourceIndex, kind: point.kind, ...(point.phase ? { phase: point.phase } : {}) }, point.nodeId, attemptId);
  }
  /** Commit one automatic boundary or prepare the next action. Actual action
   * arguments stay private/encrypted, never in public receipts or events. */
  async advance(assertContext?: (state: Readonly<RepositoryState>) => void): Promise<IterationBoundary | null> {
    return this.commit(async (state, item) => {
      assertContext?.(state); this.assertAuthority(state, item); const point = await this.next(item, state); assertContext?.(state); this.assertAuthority(state, item); if (!point) return null;
      const previous = item.iterationProgress.receipts[receiptKey(point.kind, point.visit.invocationId)];
      if (previous?.kind === "action" && ["PREPARING", "DISPATCH_INTENT"].includes(previous.status)) throw new Error("An existing action attempt cannot be replayed or prepared twice");
      const timestamp = new Date().toISOString();
      const receipt: Omit<IterationReceipt, "seal"> = { nodeId: point.nodeId, invocationId: point.visit.invocationId, iterations: structuredClone(point.visit.iterations), sourceIndex: point.sourceIndex, kind: point.kind === "skip" ? "action" : point.kind, status: point.valid ? "DONE" : "FAILED", recordedAt: timestamp };
      if (point.kind === "action" || point.kind === "skip") {
        const attempt: ReadRunAttempt = { id: `iteration-attempt-${randomBytes(8).toString("hex")}`, nodeId: point.nodeId, invocationId: point.visit.invocationId, iterations: structuredClone(point.visit.iterations), stepIndex: point.sourceIndex, status: point.kind === "skip" ? "SKIPPED" : point.valid ? "PREPARING" : "FAILED", startedAt: timestamp, ...(point.kind === "skip" || !point.valid ? { completedAt: timestamp } : {}) };
        if (Object.hasOwn(item.readProgress.attempts, point.visit.invocationId)) throw new Error("Invocation already has an attempt");
        item.readProgress.attempts[point.visit.invocationId] = attempt; receipt.status = attempt.status; receipt.attemptId = attempt.id;
        if (point.dataBinding) receipt.dataBinding = point.dataBinding;
        if (point.reason) receipt.reason = point.reason;
        (state.timelines[item.id] ??= []).push({ id: attempt.id, attemptId: attempt.id, boundaryKey: receiptKey(point.kind, point.visit.invocationId), nodeId: point.nodeId, invocationId: point.visit.invocationId, iterations: point.visit.iterations, status: attempt.status === "PREPARING" ? "RUNNING" : attempt.status, startedAt: timestamp, completedAt: attempt.completedAt ?? null, durationMs: 0, sideEffect: false, ...(point.reason ? { reason: point.reason } : {}), outcome: point.kind === "skip" ? "ITERATION_NOT_EVALUATED" : point.valid ? "PREPARING" : "ARGUMENTS_INVALID" });
      } else if (point.kind === "collection" && point.phase === "start") {
        receipt.status = point.valid ? "STARTED" : "FAILED"; if (point.count !== undefined) receipt.count = point.count; if (point.dataBinding) receipt.dataBinding = point.dataBinding;
      } else if (point.kind === "condition") { if (point.selected) receipt.selected = point.selected; }
      else if (point.valid) {
        const output = { value: point.value }; receipt.outputBinding = this.outputBinding(output); (item.valueOutputs ??= {})[point.visit.invocationId] = output;
        if (point.kind === "collection") { if (!previous || previous.status !== "STARTED") throw new Error("Collection value lacks its start"); receipt.sourceIndex = previous.sourceIndex; receipt.completionIndex = point.sourceIndex; if (previous.count !== undefined) receipt.count = previous.count; if (previous.dataBinding !== undefined) receipt.dataBinding = previous.dataBinding; }
        if (point.kind === "return") item.finalOutput = point.value;
      }
      if (point.kind !== "action" && point.kind !== "skip") {
        const key = receiptKey(point.kind, point.visit.invocationId), entries = state.timelines[item.id] ??= [];
        let entry = entries.find(value => value.boundaryKey === key);
        if (!entry) { entry = { id: `iteration-value-${randomBytes(8).toString("hex")}`, boundaryKey: key, nodeId: point.nodeId, invocationId: point.visit.invocationId, iterations: point.visit.iterations, startedAt: timestamp, sideEffect: false }; entries.push(entry); }
        Object.assign(entry, { status: receipt.status === "STARTED" ? "RUNNING" : receipt.status, completedAt: receipt.status === "STARTED" ? null : timestamp, outcome: `ITERATION_${point.kind.toUpperCase().replaceAll("-", "_")}`, ...(point.count !== undefined ? { count: point.count } : {}), ...(point.selected ? { selectedBranch: point.selected } : {}), ...(point.valid && point.kind !== "condition" && point.phase !== "start" ? { output: { value: point.value } } : {}) });
      }
      this.put(item, receipt); this.emit(state, item, `iteration.${point.kind}.${receipt.status.toLowerCase()}`, point, receipt.attemptId);
      return structuredClone(point);
    });
  }
  private async actionPoint(item: BoundExecution, journal: RepositoryState, visit: ReadVisit, status: "PREPARING" | "DISPATCH_INTENT", selected?: { prior: readonly CompletedRead[] }): Promise<{ point: IterationBoundary; receipt: IterationReceipt; attempt: ReadRunAttempt }> {
    const point = await this.next(item, journal, selected), receipt = item.iterationProgress.receipts[receiptKey("action", visit.invocationId)], attempt = item.readProgress.attempts[visit.invocationId];
    if (!point || point.kind !== "action" || !same(point.visit, visit) || !point.valid || !receipt || receipt.status !== status || !attempt || attempt.status !== status || receipt.attemptId !== attempt.id || attempt.nodeId !== point.nodeId || !same(attempt.iterations, visit.iterations)) throw new Error("Invocation is not the exact current action boundary");
    return { point, receipt, attempt };
  }
  /** Private server evidence, not an HTTP payload, token or dispatch grant.
   * Restore the exact PREPARING action and its visible confirmed reads
   * under authoritative storage/current controller checks, without a write. */
  private selectedRecord(item: BoundExecution, point: IterationBoundary, attempt: ReadRunAttempt, prior: readonly CompletedRead[]): ReadSelectedEvidence {
    return { profile: "read-selected-evidence/v1", executionId: item.id, epoch: this.epoch, inputBinding: item.iterationProgress.inputBinding,
      sourceHash: this.#plan.sourceHash, semanticHash: this.#plan.semanticHash, actorId: item.startedBy.id, admittedRole: item.iterationProgress.admittedRole,
      nodeId: point.nodeId, sourceIndex: point.sourceIndex, attemptId: attempt.id, visit: structuredClone(point.visit), args: structuredClone(point.arguments!), prior };
  }
  async selectedEvidence(visit: ReadVisit): Promise<ReadSelectedEvidence> {
    try { return await this.repository.readAuthoritative(async state => {
      const item = this.current(state); this.assertAuthority(state, item);
      const selected: { prior: readonly CompletedRead[] } = { prior: [] };
      const { point, attempt } = await this.actionPoint(item, state, visit, "PREPARING", selected); this.assertAuthority(state, item);
      return this.selectedRecord(item, point, attempt, selected.prior);
    }); } catch (cause) { if (cause instanceof ReadRunCancelled) throw cause; throw new ReadCheckpointFailure(cause); }
  }
  async dispatchIntent(visit: ReadVisit, verifiedRole: string, binding?: {
    selectedEvidence: ReadSelectedEvidence;
    /** Server-only synchronous check in the same intent transaction; no I/O. */
    assertContext: (state: Readonly<RepositoryState>) => void;
  }): Promise<void> {
    await this.commit(async (state, item) => {
      binding?.assertContext(state);
      this.assertAuthority(state, item); if (verifiedRole !== item.iterationProgress.admittedRole) throw new Error("Verified role differs from the admitted iteration role");
      const selected = binding ? { prior: [] as readonly CompletedRead[] } : undefined;
      const { point, receipt, attempt } = await this.actionPoint(item, state, visit, "PREPARING", selected);
      if (binding && !same(binding.selectedEvidence, this.selectedRecord(item, point, attempt, selected!.prior))) throw new Error("Selected prerequisite or exact argument evidence changed before dispatch intent");
      binding?.assertContext(state);
      this.assertAuthority(state, item);
      const timestamp = new Date().toISOString(); attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = timestamp;
      const entry = state.timelines[item.id]?.find(value => value.attemptId === attempt.id); if (!entry) throw new Error("Dispatch intent lacks its prepared timeline");
      Object.assign(entry, { phase: "DISPATCH_INTENT", outcome: "DISPATCH_INTENT" });
      const { seal: _seal, ...record } = receipt; this.put(item, { ...record, status: "DISPATCH_INTENT", recordedAt: timestamp });
      this.emit(state, item, "iteration.action.dispatch_intent", point, attempt.id);
    });
  }
  async completed(visit: ReadVisit, rawOutput: unknown): Promise<void> {
    await this.commit(async (state, item) => {
      // Cancellation/revocation cannot erase a confirmed in-flight answer.
      // No next boundary may start without the authority/cancel check above.
      const { point, receipt, attempt } = await this.actionPoint(item, state, visit, "DISPATCH_INTENT");
      const definition = this.#plan.ir.root.nodes[point.sourceIndex]!, tool = this.#tools.find(value => value.tool_id === definition.capability.toolId)!;
      const output = safeMcpToolResult(rawOutput, tool), error = output.isError === true;
      const timestamp = new Date().toISOString(); attempt.status = error ? "FAILED" : "DONE"; attempt.completedAt = timestamp;
      const { seal: _seal, ...record } = receipt; this.put(item, { ...record, status: attempt.status, recordedAt: timestamp, ...(!error ? { outputBinding: this.outputBinding(output) } : {}) });
      const entry = state.timelines[item.id]?.find(value => value.attemptId === attempt.id); if (!entry) throw new Error("Iteration attempt lacks its timeline");
      Object.assign(entry, { status: attempt.status, outcome: error ? "TOOL_REPORTED_ERROR" : "ITERATION_READ_COMPLETED", completedAt: timestamp, durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(attempt.startedAt)), output });
      if (!error) { (item.stepOutputs ??= {})[visit.invocationId] = output; item.finalOutput = output; }
      this.emit(state, item, error ? "iteration.action.failed" : "iteration.action.completed", point, attempt.id);
    });
  }
  async failed(visit: ReadVisit): Promise<void> {
    await this.commit(async (state, item) => {
      const existing = item.iterationProgress.receipts[receiptKey("action", visit.invocationId)];
      if (!existing || !["PREPARING", "DISPATCH_INTENT"].includes(existing.status)) throw new Error("No active iteration action to stop");
      const { point, receipt, attempt } = await this.actionPoint(item, state, visit, existing.status as "PREPARING" | "DISPATCH_INTENT");
      const timestamp = new Date().toISOString(); attempt.status = existing.status === "DISPATCH_INTENT" ? "UNKNOWN" : "FAILED"; attempt.completedAt = timestamp;
      const { seal: _seal, ...record } = receipt; this.put(item, { ...record, status: attempt.status, recordedAt: timestamp });
      const entry = state.timelines[item.id]?.find(value => value.attemptId === attempt.id); if (!entry) throw new Error("Iteration attempt lacks its timeline");
      Object.assign(entry, { status: attempt.status, outcome: attempt.status === "UNKNOWN" ? "UNKNOWN" : "NOT_DISPATCHED", completedAt: timestamp });
      this.emit(state, item, attempt.status === "UNKNOWN" ? "iteration.action.outcome_unknown" : "iteration.action.failed", point, attempt.id);
    });
  }
  async finish(failed = false, assertContext?: (state: Readonly<RepositoryState>) => void): Promise<Execution> {
    return this.commit(async (state, item) => {
      const cancelled = !!item.readProgress.cancellation || !!this.signal?.aborted;
      if (failed || cancelled) for (const [address, attempt] of Object.entries(item.readProgress.attempts)) if (["PREPARING", "DISPATCH_INTENT"].includes(attempt.status)) {
        const receipt = item.iterationProgress.receipts[receiptKey("action", address)];
        if (!receipt || receipt.attemptId !== attempt.id || receipt.status !== attempt.status) throw new Error("Active iteration attempt is inconsistent");
        const timestamp = new Date().toISOString(); attempt.status = attempt.status === "DISPATCH_INTENT" ? "UNKNOWN" : cancelled ? "CANCELLED" : "FAILED"; attempt.completedAt = timestamp;
        const { seal: _seal, ...record } = receipt; this.put(item, { ...record, status: attempt.status, recordedAt: timestamp });
        const entry = state.timelines[item.id]?.find(value => value.attemptId === attempt.id); if (!entry) throw new Error("Stopped iteration lacks its timeline");
        Object.assign(entry, { status: attempt.status, completedAt: timestamp, outcome: attempt.status === "UNKNOWN" ? "UNKNOWN" : "NOT_DISPATCHED" });
        this.emit(state, item, attempt.status === "UNKNOWN" ? "iteration.action.outcome_unknown" : "iteration.action.stopped", { kind: "action", nodeId: receipt.nodeId, sourceIndex: receipt.sourceIndex, visit: { invocationId: address, iterations: receipt.iterations }, valid: false }, attempt.id);
      }
      const uncertain = Object.values(item.readProgress.attempts).some(value => value.status === "UNKNOWN");
      if (!uncertain && !item.readProgress.cancellation && !this.signal?.aborted && !failed) {
        assertContext?.(state); this.assertAuthority(state, item); if (await this.next(item, state)) throw new Error("Cannot declare a collection run DONE with unconfirmed iteration boundaries"); assertContext?.(state); this.assertAuthority(state, item);
      }
      if (!uncertain && !item.readProgress.cancellation && !this.signal?.aborted && failed && Object.values(item.readProgress.attempts).some(value => value.status === "DISPATCH_INTENT")) throw new Error("Unacknowledged intent must be marked UNKNOWN before finishing");
      item.status = uncertain ? "RECOVERY_REQUIRED" : item.readProgress.cancellation || this.signal?.aborted ? "CANCELLED" : failed ? "FAILED" : "DONE";
      if (item.status !== "DONE") {
        const stopped = Object.values(item.readProgress.attempts).find(value => value.status === "UNKNOWN") ?? Object.values(item.readProgress.attempts).findLast(value => ["FAILED", "CANCELLED"].includes(value.status));
        item.failure = { failureCategory: uncertain ? "READ_OUTCOME_UNKNOWN" : item.status === "CANCELLED" ? "READ_CANCELLED" : "READ_COLLECTION_FAILED", failedStepId: stopped?.nodeId ?? "collection", ...(stopped?.invocationId ? { failedInvocationId: stopped.invocationId } : {}), reason: "Collection execution stopped without automatic replay" };
      }
      item.completedAt = new Date().toISOString(); item.durationMs = Math.max(0, Date.parse(item.completedAt) - Date.parse(item.startedAt));
      item.agentSummary = item.status === "DONE" ? "All selected iteration boundaries are confirmed; no automatic replay was performed." : "Collection execution stopped. Confirmed per-item answers remain saved; incomplete or uncertain work is not replayed.";
      appendExecutionEvent(state, item, item.status === "RECOVERY_REQUIRED" ? "run.recovery_required" : "run.completed", { status: item.status, iterationProfile: "read-iterations/v1" });
      return structuredClone(item);
    });
  }
}
