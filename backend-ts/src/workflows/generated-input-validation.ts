import type { WorkflowBlueprint } from "../models/schemas.js";
import { schemaAt } from "./read-binding-validation.js";

/** New generated plans must declare the inputs they actually bind. Legacy
 * publications remain immutable; runtime admission still validates each run. */
export function generatedInputBindingIssues(blueprint: WorkflowBlueprint): string[] {
  const schema = blueprint.trigger.config?.inputSchema as Record<string, unknown> | undefined;
  const paths = new Map<string, string[]>();
  let visited = 0;
  const visit = (value: unknown, depth = 0) => {
    if (++visited > 20_000 || depth > 40) throw new Error("Generated input references exceed supported limits");
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{\{\s*input\.([A-Za-z0-9_.-]+)\s*\}\}/g)) {
        const path = match[1]!.split("."); paths.set(path.join("."), path);
      }
    } else if (Array.isArray(value)) value.forEach(child => visit(child, depth + 1));
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.kind === "ref" && record.source === "workflowInput" && Array.isArray(record.path) && record.path.every(part => typeof part === "string"))
        paths.set(record.path.join("."), record.path as string[]);
      Object.values(record).forEach(child => visit(child, depth + 1));
    }
  };
  try { blueprint.steps.forEach(step => { visit(step.parameters); visit(step.input); }); visit(blueprint.metadata?.controlFlow); }
  catch { return ["Generated input references exceed supported limits"]; }
  return [...paths].flatMap(([name, path]) => {
    if (!schema || !schemaAt(schema, path)?.type) return [`Workflow input ${name || "object"} needs an exact declared type in trigger.config.inputSchema`];
    let parent = schema;
    for (const key of path) {
      if (parent.type === "object" && !(parent.required as string[] | undefined)?.includes(key)) return [`Bound workflow input ${name} must be required so Run collects it before execution`];
      parent = schemaAt(parent, [key])!;
    }
    return [];
  });
}
