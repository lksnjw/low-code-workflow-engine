import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundedOperation } from "../core/bounded-operation.js";
import type { ChatOperation, Repository } from "../repository/store.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "../runner/execution-host.js";

const id = z.string().min(1).max(256);
export const chatTaskCommandSchema = z.object({ profile: z.literal("chat-task-delivery/v1"), operationId: id,
  taskId: z.string().regex(/^chat-[a-f0-9]{64}$/) }).strict();
export type ChatTaskCommand = z.infer<typeof chatTaskCommandSchema>;
const outboxSchema = z.object({ profile: z.literal("chat-task-outbox/v1"), operationId: id, taskId: z.string().regex(/^chat-[a-f0-9]{64}$/),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"]),
  attempts: z.number().int().min(0).max(1000), createdAt: z.iso.datetime(), intentAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime().optional() }).strict();
export type ChatTaskOutbox = z.infer<typeof outboxSchema>;
export type ChatTaskTransport = Readonly<{ timeoutMs: number;
  enqueue(command: ChatTaskCommand, signal: AbortSignal): Promise<{ taskId: string; outcome: "CREATED" | "ALREADY_EXISTS" }> }>;
export const chatTaskLeaseSchema = z.object({ profile: z.literal("chat-task-lease/v1"), workerId: id, epoch: z.number().int().positive(),
  claimedAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).strict();
const transports = new WeakMap<Repository, ChatTaskTransport>();
const hash = (value: unknown) => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
function identity(op: ChatOperation) {
  return { profile: "chat-task-binding/v1", operationId: op.id, sessionId: op.sessionId, actorId: op.actorId, userMessageId: op.userMessageId,
    idempotencyScope: op.idempotencyScope, requestFingerprint: op.requestFingerprint, authorityFingerprint: op.authorityFingerprint,
    connectionFingerprint: op.connectionFingerprint, contractFingerprint: op.contractFingerprint, modelBinding: op.modelBinding,
    ...(op.erpCredentialSecret ? { erpCredentialBinding: op.erpCredentialSecret } : {}),
    nodeContext: op.nodeContext ?? null, requestRevision: op.requestRevision ?? null, createdAt: op.createdAt };
}
export function newChatTaskOutbox(op: ChatOperation): ChatTaskOutbox {
  const bindingHash = hash(identity(op));
  return outboxSchema.parse({ profile: "chat-task-outbox/v1", operationId: op.id, taskId: `chat-${bindingHash}`, bindingHash,
    state: "PREPARED", attempts: 0, createdAt: op.createdAt });
}
export function assertChatTaskOutbox(op: ChatOperation): ChatTaskOutbox {
  const record = outboxSchema.parse(op.taskDispatchSecret), bindingHash = hash(identity(op));
  if (record.operationId !== op.id || record.bindingHash !== bindingHash || record.taskId !== `chat-${bindingHash}` || record.createdAt !== op.createdAt ||
      record.state === "PREPARED" && (record.attempts !== 0 || record.intentAt || record.acceptedAt) ||
      record.state !== "PREPARED" && (record.attempts < 1 || !record.intentAt) || record.state === "ENQUEUED" && !record.acceptedAt ||
      record.state !== "ENQUEUED" && record.acceptedAt || record.intentAt && Date.parse(record.intentAt) < Date.parse(record.createdAt) ||
      record.acceptedAt && Date.parse(record.acceptedAt) < Date.parse(record.intentAt!)) throw new Error("Chat task identity or dispatch history changed");
  return record;
}
/** Installed only by server composition for one authoritative ownership scope. */
export function configureChatTaskDispatch(repository: Repository, transport: ChatTaskTransport): void {
  if (bindExecutionHost(repository) !== "bounded-invocation" || transports.has(repository)) throw new Error("Chat task dispatch requires a new bounded owner");
  if (!transport || typeof transport.enqueue !== "function" || !Number.isSafeInteger(transport.timeoutMs) || transport.timeoutMs < 1 || transport.timeoutMs > 30_000)
    throw new Error("Chat enqueue requires a bounded transport");
  const storage = repository.persistence;
  if (storage && storage.readQueueDurability !== "encrypted-single-writer") throw new Error("Chat task admission requires acknowledged encrypted single-writer storage");
  repository.assertAuthority(); transports.set(repository, Object.freeze({ enqueue: transport.enqueue.bind(transport), timeoutMs: transport.timeoutMs }));
}
export function requireChatTaskAdmission(repository: Repository): void {
  if (residentExecutionAllowed(repository)) return;
  if (!transports.has(repository)) requireResidentExecution(repository);
  repository.assertAuthority();
}
export function chatTaskAdmissionAvailable(repository: Repository): boolean {
  return residentExecutionAllowed(repository) || transports.has(repository);
}
/** Queue acceptance follows acknowledged admission and enqueue intention.
 * Recovery reuses the same identity; it cannot run a model or an ERP tool. */
export async function dispatchChatTaskOutbox(repository: Repository, operationId: string): Promise<"ENQUEUED" | "PENDING" | "NOT_NEEDED"> {
  if (residentExecutionAllowed(repository)) throw new Error("Resident chat workers cannot dispatch task-owned work");
  const transport = transports.get(repository); if (!transport) throw new Error("Chat task transport is unavailable");
  const prepared = await repository.mutate(state => {
    const op = state.chatOperations[operationId]; if (!op) throw new Error("Original chat operation is unavailable");
    const record = assertChatTaskOutbox(op);
    if (record.state === "ENQUEUED") return { state: "ENQUEUED" as const };
    if (op.status !== "QUEUED") return { state: "NOT_NEEDED" as const };
    if (record.attempts >= 1000) throw new Error("Chat task dispatch bound exceeded; operator review is required");
    op.taskDispatchSecret = { ...record, state: "ENQUEUE_INTENT", attempts: record.attempts + 1, intentAt: new Date().toISOString() };
    assertChatTaskOutbox(op);
    return { state: "DISPATCH" as const, attempt: record.attempts + 1,
      command: chatTaskCommandSchema.parse({ profile: "chat-task-delivery/v1", operationId, taskId: record.taskId }) };
  });
  if (prepared.state !== "DISPATCH") return prepared.state;
  const controller = new AbortController();
  try {
    repository.assertAuthority();
    const accepted = await boundedOperation(() => transport.enqueue(Object.freeze(prepared.command), controller.signal), {
      timeoutMs: transport.timeoutMs, label: "Chat task enqueue", onAbandon: () => controller.abort() });
    if (!accepted || accepted.taskId !== prepared.command.taskId || !["CREATED", "ALREADY_EXISTS"].includes(accepted.outcome) ||
        Object.keys(accepted).some(key => !["taskId", "outcome"].includes(key))) throw new Error("Chat queue acknowledgement is not exact");
    repository.assertAuthority();
    await repository.mutate(state => {
      const op = state.chatOperations[operationId]; if (!op) throw new Error("Original chat disappeared");
      const record = assertChatTaskOutbox(op); if (record.state === "ENQUEUED") return;
      if (record.state !== "ENQUEUE_INTENT" || record.taskId !== prepared.command.taskId || record.attempts !== prepared.attempt)
        throw new Error("Chat queue acknowledgement was superseded");
      op.taskDispatchSecret = { ...record, state: "ENQUEUED", acceptedAt: new Date().toISOString() }; assertChatTaskOutbox(op);
    });
    return "ENQUEUED";
  } catch {
    try { repository.assertAuthority(); } catch { throw new HandlerFailure(503,
      "Chat dispatch acknowledgement is unconfirmed. Reload the original operation and reuse its original request key.", { code: "CHAT_TASK_ACK_UNCONFIRMED", operationId }); }
    return "PENDING";
  } finally { controller.abort(); }
}
export async function recoverChatTaskOutboxes(repository: Repository, limit = 10): Promise<{ inspected: number; pending: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || residentExecutionAllowed(repository) || !transports.has(repository))
    throw new Error("Chat dispatch recovery requires a bounded owned dispatcher and limit");
  const ids = await repository.readAuthoritative(state => Object.values(state.chatOperations).filter(op =>
    op.taskDispatchSecret && op.status === "QUEUED" && assertChatTaskOutbox(op).state !== "ENQUEUED")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit).map(op => op.id));
  let pending = 0; for (const id of ids) if (await dispatchChatTaskOutbox(repository, id) === "PENDING") pending++;
  return { inspected: ids.length, pending };
}
