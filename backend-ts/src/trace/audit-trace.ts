import { workflowContentHash } from "../parser/workflow.js";
import type { Repository } from "../repository/store.js";

export type TraceAuditMetadata = {
  traceId?: string | undefined;
  sessionId?: string | undefined;
  messageId?: string | undefined;
  candidateId?: string | undefined;
  workflowId?: string | undefined;
  executionId?: string | undefined;
  actor?: { id: string; role: string } | undefined;
};

/*******************************************************************************
 * Function: attachValidationAuditTrace
 *
 * Links trace metadata to the matching validation audit record.
 ******************************************************************************/
export async function attachValidationAuditTrace(
  repository: Repository,
  action: string,
  rawYAML: string,
  metadata: TraceAuditMetadata,
): Promise<void> {
  const resourceID = workflowContentHash(rawYAML);
  await repository.mutate((state) => {
    const record = [...state.auditLogs].reverse().find((candidate) => {
      const resource = candidate.resource;
      return candidate.source === "deterministic-validation-gate-ts"
        && candidate.action === `validation.gate.${action}`
        && typeof resource === "object"
        && resource !== null
        && (resource as Record<string, unknown>).id === resourceID
        && candidate.traceId === undefined;
    });
    if (record !== undefined) Object.assign(record, definedMetadata(metadata));
  });
}

/*******************************************************************************
 * Function: attachDispatchAuditTrace
 *
 * Links trace metadata to dispatch audit records for an execution.
 ******************************************************************************/
export async function attachDispatchAuditTrace(
  repository: Repository,
  executionID: string,
  metadata: TraceAuditMetadata,
): Promise<void> {
  await repository.mutate((state) => {
    for (const record of state.auditLogs) {
      if (record.source === "deterministic-validation-gate-ts"
        && record.action === `dispatch.${executionID}`
        && record.traceId === undefined) {
        Object.assign(record, definedMetadata(metadata));
      }
    }
  });
}

/*******************************************************************************
 * Function: definedMetadata
 *
 * Removes undefined fields from trace audit metadata.
 ******************************************************************************/
function definedMetadata(metadata: TraceAuditMetadata): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}
