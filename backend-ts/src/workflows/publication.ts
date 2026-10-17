import type { FastifyRequest } from "fastify";
import { HandlerFailure, appendAudit, nextID, now, stringValue, validateWorkflow, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { workflowContentHash } from "../parser/workflow.js";
import { requestTraceId } from "../trace/request-trace.js";
import { assertWorkflowMutable, assertCurrentWorkflowEditor } from "./commands.js";
import { savedGeneratedReturnCoverageIssues } from "../synthesis/return-coverage.js";
import { validateWorkspaceDraft } from "./draft-validation.js";
import { prepareReadPublication, assertReadPublicationCurrent } from "./read-compilation-lifecycle.js";
import { prepareOperationPublication, assertOperationPublicationCurrent } from "./operation-compilation-lifecycle.js";
import { savedDraftHistory } from "./draft-history.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";

/** Optional legacy publication API. Always validates and pins the exact
 * saved revision; never approves effects or dispatches an ERP call. */
export async function publishWorkflowSnapshot(workflowId: string, body: Record<string, unknown>, request: FastifyRequest, user: CurrentUser, services: HandlerServices) {
  const id = workflowId;
  const current = await services.repository.read((state) => structuredClone(state.workflows[id] ?? null));
  if (current === null) throw new HandlerFailure(404, "Workflow not found");
  assertWorkflowMutable(current);
  if (body.baseVersion !== undefined || body.baseHash !== undefined) {
    if (!Number.isInteger(body.baseVersion) || typeof body.baseHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.baseHash)) throw new HandlerFailure(400, "Invalid publication revision");
    if (body.baseVersion !== current.draftVersion || body.baseHash !== workflowContentHash(current.yaml)) throw new HandlerFailure(409, "Reviewed draft changed; reload before publishing", { code: "DRAFT_REVISION_CONFLICT" });
  }
  if (current.status === "draft-unvalidated") throw new HandlerFailure(422, "Workflow must be validated before publishing", { status: current.status });
  const expectedHash = workflowContentHash(current.yaml);
  const traceId = requestTraceId(request, current.traceId);
  const coverageIssues = savedGeneratedReturnCoverageIssues(current);
  if (coverageIssues.length) throw new HandlerFailure(422, "Generated workflow contains unreachable requested work or answers; edit the draft before publication", { code: "GENERATED_RETURN_COVERAGE_INVALID", issues: coverageIssues, traceId });
  const draftValidation = validateWorkspaceDraft("PublishWorkflow", current.yaml, user.role, services.validator, services.registries.snapshot().tools);
  if (!draftValidation.passed) throw new HandlerFailure(422, "Workflow must pass executable draft validation before publishing", { ...draftValidation, traceId });
  const gate = await validateWorkflow(services, "PublishWorkflow", current.yaml, user, { traceId, workflowId: current.id });
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", { ...gate.result, traceId });
  const compilation = await prepareReadPublication(services, current.yaml, user);
  const operationCompilation = compilation ? null : await prepareOperationPublication(services, current.yaml, user);
  if (!compilation && !operationCompilation) throw new HandlerFailure(422, "Workflow has no supported executable publication profile", { code: "UNSUPPORTED_PUBLICATION_PROFILE", traceId });
  const version = await services.repository.mutate((state) => {
    const item = state.workflows[id];
    if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    const publisher = assertCurrentWorkflowEditor(state, item, user);
    if (item.draftVersion !== current.draftVersion || workflowContentHash(item.yaml) !== expectedHash) throw new HandlerFailure(409, "Workflow content changed during validation", { code: "DRAFT_REVISION_CONFLICT" });
    if (savedGeneratedReturnCoverageIssues(item).length) throw new HandlerFailure(422, "Generated return coverage changed during publication", { code: "GENERATED_RETURN_COVERAGE_INVALID" });
    const editHistory = savedDraftHistory(state, item);
    if (compilation) assertReadPublicationCurrent(compilation, services, state, item.yaml, publisher.role);
    if (operationCompilation) assertOperationPublicationCurrent(operationCompilation, services, state, item.yaml, publisher.role);
    const previous = (state.versions[id] ?? []).findLast(value => value.version === item.draftVersion && value.artifactState === "PUBLISHED");
    if (previous) {
      const oldReceipt = (previous.compiledRead as { receipt?: unknown } | undefined)?.receipt ?? null;
      const oldOperationReceipt = (previous.compiledOperation as { receipt?: unknown } | undefined)?.receipt ?? null;
      if (previous.yaml === item.yaml && canonicalJSONBytes(oldReceipt).equals(canonicalJSONBytes(compilation?.stored.receipt ?? null)) && canonicalJSONBytes(oldOperationReceipt).equals(canonicalJSONBytes(operationCompilation?.stored.receipt ?? null))) return structuredClone(previous);
      // Rebinding a review is a new immutable version, even with unchanged
      // authoring YAML. Never overwrite/append a different version N as N.
      item.draftVersion = Math.max(item.draftVersion, item.publishedVersion) + 1;
    }
    item.publishedVersion = item.draftVersion; item.canRun = Boolean(compilation || operationCompilation); item.updatedAt = now();
    const value = { id: nextID(state, "ver"), workflowId: id, version: item.publishedVersion, artifactState: "PUBLISHED", versionNote: stringValue(body.versionNote), yaml: item.yaml, createdAt: now(), createdBy: { id: user.id, name: user.name },
      ...(compilation ? { compiledRead: compilation.stored } : {}), ...(operationCompilation ? { compiledOperation: operationCompilation.stored } : {}), ...(editHistory ? { editHistory, contentHash: expectedHash } : {}), executionReadiness: compilation ? "COMPILED_READ" : operationCompilation ? "COMPILED_OPERATION" : "UNSUPPORTED_PROFILE" };
    const versions = state.versions[id] ?? [];
    versions.push(value); state.versions[id] = versions;
    appendAudit(state, publisher, "workflow.published", "workflow", id, null, { version: item.publishedVersion, contentHash: expectedHash, semanticHash: compilation?.stored.receipt.semanticHash ?? operationCompilation?.stored.receipt.semanticHash ?? null }, request);
    return value;
  });
  return version;
}
