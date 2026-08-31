import { createHash } from "node:crypto";
import { parseAllDocuments, stringify } from "yaml";
import { workflowBlueprintSchema, type WorkflowBlueprint } from "../models/schemas.js";

const exactVariablePattern = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;
const variablePattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/*******************************************************************************
 * Function: stripMarkdownFence
 *
 * Removes an enclosing Markdown code fence from text.
 ******************************************************************************/
export function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:ya?ml)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match?.[1] ?? raw;
}

/*******************************************************************************
 * Function: parseWorkflowYAMLStrict
 *
 * Parses workflow YAML and checks the required blueprint structure.
 ******************************************************************************/
export function parseWorkflowYAMLStrict(raw: string): WorkflowBlueprint {
  const input = stripMarkdownFence(raw);
  const documents = parseAllDocuments(input, { strict: true, uniqueKeys: true });
  if (documents.length !== 1) {
    throw new Error("parse workflow yaml: multiple YAML documents are not allowed");
  }
  const document = documents[0];
  if (document === undefined) throw new Error("parse workflow yaml: empty decoder result");
  if (document.errors.length > 0) {
    throw new Error(`parse workflow yaml: ${document.errors[0]?.message ?? "invalid YAML"}`);
  }
  const decoded: unknown = document.toJS({ mapAsMap: false, maxAliasCount: 100 });
  const result = workflowBlueprintSchema.safeParse(decoded);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length === 0 ? "root" : issue?.path.join(".");
    throw new Error(`parse workflow yaml: ${location}: ${issue?.message ?? "schema validation failed"}`);
  }
  return result.data;
}

/*******************************************************************************
 * Function: stringifyWorkflowYAML
 *
 * Serializes a workflow blueprint as YAML.
 ******************************************************************************/
export function stringifyWorkflowYAML(workflow: WorkflowBlueprint): string {
  return stringify(workflow, { lineWidth: 0 });
}

/*******************************************************************************
 * Function: checksum
 *
 * Computes a checksum for the supplied text.
 ******************************************************************************/
export function checksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/*******************************************************************************
 * Function: workflowContentHash
 *
 * Computes the content hash used to identify workflow YAML.
 ******************************************************************************/
export function workflowContentHash(value: string): string {
  return `sha256:${checksum(value)}`;
}

/*******************************************************************************
 * Function: resolveVariables
 *
 * Resolves workflow template variables in a parameter record.
 ******************************************************************************/
export function resolveVariables<T>(value: T, state: Record<string, unknown>): T {
  return resolveValue(value, state) as T;
}

/*******************************************************************************
 * Function: resolveValue
 *
 * Recursively resolves template expressions in a value.
 ******************************************************************************/
function resolveValue(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = exactVariablePattern.exec(value.trim());
    if (exact?.[1] !== undefined) {
      const found = lookupPath(state, exact[1]);
      if (found.exists) return found.value;
    }
    return value.replace(variablePattern, (match, path: string) => {
      const found = lookupPath(state, path);
      return found.exists ? goString(found.value) : match;
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, state));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, state)]));
  }
  return value;
}

/*******************************************************************************
 * Function: lookupPath
 *
 * Looks up a dotted path in the workflow execution state.
 ******************************************************************************/
function lookupPath(state: Record<string, unknown>, path: string): { exists: boolean; value?: unknown } {
  let current: unknown = state;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return { exists: false };
    current = current[part];
  }
  return { exists: true, value: current };
}

/*******************************************************************************
 * Function: goString
 *
 * Formats a value using the string conventions expected by the Go port.
 ******************************************************************************/
function goString(value: unknown): string {
  if (value === null || value === undefined) return "<nil>";
  if (typeof value === "object") return String(value);
  return String(value);
}

/*******************************************************************************
 * Function: isRecord
 *
 * Checks whether a value is a non-null object other than an array.
 ******************************************************************************/
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
