import type { FastifyRequest } from "fastify";
import type { Workflow } from "../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { requireWorkflowBase, assertWorkflowMutable } from "./commands.js";
import { resolveReadBinding } from "./compiled-read.js";
import { prepareStartSnapshot } from "./start-snapshot.js";

/** Start is consent to prepare this exact draft for execution, not consent to
 * an ERP effect. Published bindings are never silently rebound on a new run. */
export async function prepareWorkflowStart(workflow: Workflow, revision: { baseVersion: number; baseHash: string },
  input: Record<string, unknown>, request: FastifyRequest, user: CurrentUser, services: HandlerServices): Promise<Workflow> {
  assertWorkflowMutable(workflow);
  requireWorkflowBase(workflow, revision.baseVersion, revision.baseHash);
  let source: ReturnType<typeof parseWorkflowYAMLStrict>;
  try { source = parseWorkflowYAMLStrict(workflow.yaml); }
  catch { throw new HandlerFailure(422, "The workflow YAML is invalid. Correct its structure before starting", { code: "WORKFLOW_YAML_INVALID" }); }
  const schema = source.trigger.config?.inputSchema;
  if (schema && validateToolInput(schema, input).length)
    throw new HandlerFailure(422, "Complete the required workflow inputs with values matching their declared types", { code: "WORKFLOW_INPUT_INVALID" });
  // Legacy drafts may omit inputSchema. Still reject missing input references
  // and known parameter type mismatches before creating an execution snapshot.
  let visited = 0;
  const resolveInput = (value: unknown, depth = 0): { value: unknown; pending: boolean } => {
    if (++visited > 20_000 || depth > 32) throw new HandlerFailure(422, "Workflow inputs exceed supported limits", { code: "WORKFLOW_INPUT_INVALID" });
    if (typeof value === "string") {
      let pending = false;
      const read = (expression: string) => {
        const parts = expression.trim().split(".");
        if (parts.shift() !== "input") { pending = true; return undefined; }
        try { return resolveReadBinding({ kind: "ref", source: "workflowInput", path: parts }, { input }); }
        catch { throw new HandlerFailure(422, "A required workflow input is missing. Complete the declared fields before starting", { code: "WORKFLOW_INPUT_INVALID" }); }
      };
      const exact = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
      if (exact) { const result = read(exact[1]!); return { value: pending ? value : result, pending }; }
      const result = value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression: string) => {
        const result = read(expression);
        if (pending) return match;
        if (typeof result !== "string") throw new HandlerFailure(422, "A text input mapping requires a string value", { code: "WORKFLOW_INPUT_INVALID" });
        return result;
      });
      return { value: result, pending };
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value).map(([key, child]) => [key, resolveInput(child, depth + 1)] as const);
      return { value: Array.isArray(value) ? entries.map(([, child]) => child.value) : Object.fromEntries(entries.map(([key, child]) => [key, child.value])), pending: entries.some(([, child]) => child.pending) };
    }
    return { value, pending: false };
  };
  for (const step of source.steps) {
    if (step.kind && step.kind !== "tool") continue;
    const tools = services.registries.snapshot().tools.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action);
    if (tools.length !== 1) throw new HandlerFailure(422, `Step ${step.id} requires an available registered tool`, { code: "WORKFLOW_TOOL_UNAVAILABLE", failedStepId: step.id, tool: step.action });
    const resolved = resolveInput(step.parameters ?? {});
    if (!resolved.pending && validateToolInput(tools[0]!.input_schema, resolved.value).length)
      throw new HandlerFailure(422, `Inputs for step ${step.id} do not match its registered tool schema`, { code: "WORKFLOW_INPUT_INVALID", failedStepId: step.id, tool: step.action });
  }
  if (workflow.pendingGenerationApproval?.steps.length)
    throw new HandlerFailure(409, "Resolve the pending workflow review before starting", { code: "WORKFLOW_REVIEW_REQUIRED" });
  const current = await services.repository.readAuthoritative(state => {
    const fresh = state.workflows[workflow.id];
    if (!fresh) throw new HandlerFailure(404, "Workflow not found");
    requireWorkflowBase(fresh, revision.baseVersion, revision.baseHash);
    return (state.versions[workflow.id] ?? []).some(version => version.artifactState === "PUBLISHED" && version.version === fresh.publishedVersion && version.yaml === fresh.yaml);
  });
  if (!current) await prepareStartSnapshot(workflow, request, user, services);
  return services.repository.readAuthoritative(state => {
    const fresh = state.workflows[workflow.id];
    if (!fresh || workflowContentHash(fresh.yaml) !== revision.baseHash)
      throw new HandlerFailure(409, "Workflow changed while preparing Start; review its latest inputs", { code: "WORKFLOW_CHANGED" });
    return structuredClone(fresh);
  });
}
