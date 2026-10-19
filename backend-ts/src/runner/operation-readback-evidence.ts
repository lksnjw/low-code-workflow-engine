import { toolRoleAllowed } from "../governance/tool-access.js";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import type { RepositoryState } from "../repository/store.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { toolSchema } from "../registry/schemas.js";
import { evaluateOperationReadback, resolveOperationReadbackArguments } from "../tools/operation-readback-contract.js";
import type { operationCaseEvidence } from "./operation-reconciliation.js";
import { operationReadbackJobSchema, readbackEvaluationSchema, type OperationReadbackJob } from "./operation-readback-state.js";

const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
type OperationCase = ReturnType<typeof operationCaseEvidence>;

/** Reconstruct and verify an immutable read-back result against its original
 * operation case and reviewed capability revision. Current connectivity is
 * deliberately irrelevant to historical evidence. */
export function validateHistoricalOperationReadback(state: Readonly<RepositoryState>, raw: unknown, source: OperationCase) {
  const parsedJob = operationReadbackJobSchema.safeParse(raw);
  if (!parsedJob.success) throw new Error("Stored status query record is malformed");
  const job = parsedJob.data, binding = source.node.readback;
  const revision = state.capabilityRevisions[job.admission.revisionId], parsed = toolSchema.safeParse(revision?.definition);
  const fingerprint = digest({ intentId: job.intentId, baseVersion: job.baseVersion, factsHash: job.factsHash, executionId: job.executionId, actorId: job.actorId, keyHash: job.keyHash });
  if (job.requestFingerprint !== fingerprint || Date.parse(job.createdAt) < Date.parse(source.execution.completedAt!) ||
      job.executionId !== source.execution.id || job.intentId !== source.intent.id || job.nodeId !== source.intent.nodeId || job.argumentHash !== source.intent.argumentHash ||
      source.factsHashes[job.baseVersion - 1] !== job.factsHash || !binding || binding.toolId !== job.targetId || binding.contractHash !== job.targetHash ||
      !same(binding.admission, job.admission) || source.connectionBinding !== job.connectionBinding || revision?.connectionBinding !== job.connectionBinding ||
      revision.capabilityId !== job.admission.capabilityId || revision.connectionId !== job.admission.connectionId || revision.contractHash !== job.targetHash ||
      !parsed.success || !toolRoleAllowed(parsed.data.allowed_roles, job.admittedRole) || capabilityContractHash(parsed.data) !== job.targetHash ||
      !same(job.arguments, resolveOperationReadbackArguments(source.tool, parsed.data, source.args)))
    throw new Error("Original operation or reviewed query evidence changed");
  if (job.state === "ANSWERED") {
    const evaluation = readbackEvaluationSchema.parse(evaluateOperationReadback(source.tool, parsed.data, source.args, job.result, source.intent.preparedAt, job.completedAt!));
    if (!same(evaluation, job.evaluation)) throw new Error("Stored status classification disagrees with its exact result");
  }
  return { job, target: parsed.data };
}
