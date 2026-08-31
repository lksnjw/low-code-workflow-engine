import { withoutSecretFields } from "../redact/secrets.js";
import type {
  RepositoryState,
  StoredRecord,
} from "../repository/store.js";
import { canReadExecution, type ExecutionReader } from "./execution-scope.js";

export type TraceChainEntry = {
  kind: string;
  id: string;
  timestamp: string;
  traceId: string;
  record: unknown;
};

/*******************************************************************************
 * Function: buildTraceChain
 *
 * Collects and orders records linked to a trace identifier.
 ******************************************************************************/
export function buildTraceChain(
  state: RepositoryState,
  user: ExecutionReader,
  traceId: string,
): TraceChainEntry[] {
  const entries: Array<TraceChainEntry & { sequence: number }> = [];
  let sequence = 0;
  /*******************************************************************************
   * Function: append
   *
   * Adds a sequenced record to the trace chain.
   ******************************************************************************/
  const append = (kind: string, record: StoredRecord, timestamp: string) => {
    entries.push({
      kind,
      id: stringValue(record.id),
      timestamp,
      traceId,
      record: withoutSecretFields(record),
      sequence: sequence++,
    });
  };

  for (const chat of Object.values(state.chats)) {
    if (
      chat.ownerId !== user.id &&
      !user.permissions.includes("workflow:read")
    )
      continue;
    for (const message of chat.messages) {
      if (message.traceId === traceId)
        append("chat.message", message, stringValue(message.createdAt));
    }
  }

  if (user.permissions.includes("audit:read")) {
    for (const invocation of Object.values(state.invocationProvenance)) {
      if (invocation.traceId === traceId)
        append(
          "model.invocation",
          invocation as unknown as StoredRecord,
          invocation.createdAt,
        );
    }
    for (const audit of state.auditLogs) {
      if (!isRecord(audit) || audit.traceId !== traceId) continue;
      append(auditKind(audit), audit, stringValue(audit.createdAt));
    }
  }

  for (const execution of Object.values(state.executions)) {
    if (execution.traceId !== traceId || !canReadExecution(user, execution))
      continue;
    append(
      "execution",
      execution as unknown as StoredRecord,
      execution.startedAt,
    );
    for (const log of state.executionLogs[execution.id] ?? []) {
      if (log.traceId === traceId)
        append("execution.log", log, stringValue(log.timestamp));
    }
    for (const timeline of state.timelines[execution.id] ?? []) {
      if (timeline.traceId === traceId)
        append(
          "execution.timeline",
          timeline,
          stringValue(timeline.startedAt),
        );
    }
  }

  return entries
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.sequence - right.sequence,
    )
    .map(({ sequence: _sequence, ...entry }) => entry);
}

/*******************************************************************************
 * Function: auditKind
 *
 * Classifies an audit entry by its source.
 ******************************************************************************/
function auditKind(record: StoredRecord): string {
  if (record.source === "governance-gate-ts") return "governance.decision";
  if (record.source === "deterministic-validation-gate-ts")
    return "gate.validation";
  return "audit.entry";
}

/*******************************************************************************
 * Function: isRecord
 *
 * Checks whether a value is a non-null object other than an array.
 ******************************************************************************/
function isRecord(value: unknown): value is StoredRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/*******************************************************************************
 * Function: stringValue
 *
 * Returns a string value or an empty string for other types.
 ******************************************************************************/
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
