import type { FastifyRequest } from "fastify";
import type { Workflow } from "../models/schemas.js";
import { runWorkflowToolAgent } from "../agent/workflow-tool-agent.js";
import { HandlerFailure, appendAudit, nextID, now, validateWorkflow, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { workflowContentHash } from "../parser/workflow.js";
import { requestTraceId } from "../trace/request-trace.js";
import { assertCurrentWorkflowEditor, requireWorkflowBase } from "./commands.js";
import { prepareReadPublication, assertReadPublicationCurrent } from "./read-compilation-lifecycle.js";
import { prepareOperationPublication, assertOperationPublicationCurrent } from "./operation-compilation-lifecycle.js";
import { savedGeneratedReturnCoverageIssues } from "../synthesis/return-coverage.js";

/** Runtime preparation owned by Pi, separate from the optional publication API.
 * PUBLISHED is the existing private worker's immutable-version discriminator;
 * it is retained for saved job/approval compatibility, not a user publish step.
 * Neither model prose nor an earlier draft-readiness flag grants tool authority.
 */
export async function prepareStartSnapshot(workflow: Workflow, request: FastifyRequest, user: CurrentUser, services: HandlerServices): Promise<void> {
  const hash = workflowContentHash(workflow.yaml), traceId = requestTraceId(request, workflow.traceId);
  await runWorkflowToolAgent({ toolName: "prepare_saved_workflow_run", signal: request.signal }, async signal => {
    const coverage = savedGeneratedReturnCoverageIssues(workflow);
    if (coverage.length) throw new HandlerFailure(422, "The workflow agent cannot reach all requested steps in this saved workflow", { code: "WORKFLOW_AGENT_START_BLOCKED", issues: coverage, stage: "runtime_preparation", traceId });
    // Execute the current policies inside the agent's governed preparation tool.
    // Do not reuse authoring validation or demand a separately published draft.
    const gate = await validateWorkflow(services, "StartWorkflowAgent", workflow.yaml, user, { traceId, workflowId: workflow.id, signal });
    if (!gate.result.passed) {
      const rules = gate.result.failed_rules ?? [];
      const message = rules.includes("GLOBAL-AUDIT-001")
          ? "An ERP-changing step lacks a supported runtime audit contract. Check that step's admitted operation contract."
          : "The workflow agent stopped because a current tool or policy requirement could not be satisfied";
      throw new HandlerFailure(422, message, { code: "WORKFLOW_AGENT_START_BLOCKED", stage: "runtime_preparation", failedRules: rules, gateExplanation: gate.gateExplanation, traceId });
    }
    const read = await prepareReadPublication(services, workflow.yaml, user);
    const operation = read ? null : await prepareOperationPublication(services, workflow.yaml, user);
    if (!read && !operation) throw new HandlerFailure(422, "The saved workflow uses steps that this agent runtime cannot execute", { code: "WORKFLOW_AGENT_PROFILE_UNSUPPORTED", stage: "runtime_preparation", traceId });
    signal.throwIfAborted();
    await services.repository.mutate(state => {
      signal.throwIfAborted();
      const fresh = state.workflows[workflow.id];
      if (!fresh) throw new HandlerFailure(404, "Workflow not found");
      const actor = assertCurrentWorkflowEditor(state, fresh, user);
      requireWorkflowBase(fresh, workflow.draftVersion, hash);
      if (savedGeneratedReturnCoverageIssues(fresh).length) throw new HandlerFailure(409, "Workflow changed during runtime preparation", { code: "DRAFT_REVISION_CONFLICT" });
      if (read) assertReadPublicationCurrent(read, services, state, fresh.yaml, actor.role);
      if (operation) assertOperationPublicationCurrent(operation, services, state, fresh.yaml, actor.role);
      // Concurrent Starts reuse the first immutable snapshot. Each execution
      // still has its own stable admission identity and original input bytes.
      const versions = state.versions[fresh.id] ??= [];
      const existing = versions.findLast(value => value.version === fresh.publishedVersion && value.artifactState === "PUBLISHED" && value.yaml === fresh.yaml);
      if (existing) return;
      if (versions.some(value => value.version === fresh.draftVersion && value.artifactState === "PUBLISHED"))
        fresh.draftVersion = Math.max(fresh.draftVersion, fresh.publishedVersion) + 1;
      fresh.publishedVersion = fresh.draftVersion; fresh.canRun = true; fresh.updatedAt = now();
      versions.push({ id: nextID(state, "ver"), workflowId: fresh.id, version: fresh.publishedVersion, artifactState: "PUBLISHED", yaml: fresh.yaml,
        versionNote: "Immutable execution snapshot prepared by the workflow agent on Run", createdAt: now(), createdBy: { id: actor.id, name: actor.name },
        preparation: "pi-direct-start/v1", ...(read ? { compiledRead: read.stored } : {}), ...(operation ? { compiledOperation: operation.stored } : {}),
        executionReadiness: read ? "COMPILED_READ" : "COMPILED_OPERATION" });
      appendAudit(state, actor, "workflow.execution_prepared", "workflow", fresh.id, null, { version: fresh.publishedVersion, contentHash: hash, preparation: "pi-direct-start/v1" }, request);
    });
  });
}
