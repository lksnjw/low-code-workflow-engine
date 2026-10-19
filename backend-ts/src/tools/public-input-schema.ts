import { isSecretField } from "../redact/secrets.js";
import { validateToolSchemaProfile } from "./tool-input-schema.js";

/** Typed authoring data only: no defaults, examples, credentials or tool
 * dispatch grants. Sensitive fields retain their type for manual entry. */
export function publicInputSchema(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (validateToolSchemaProfile(raw).length) return undefined;
  let nodes = 0;
  const visit = (schema: Record<string, any>, sensitive = false, depth = 0): Record<string, unknown> => {
    if (++nodes > 4096 || depth > 16) throw new Error("Input schema exceeds authoring limits");
    sensitive ||= schema.writeOnly === true;
    const result: Record<string, unknown> = schema.type && schema.type !== "" ? { type: schema.type } : {};
    if (sensitive) result.writeOnly = true;
    if (!sensitive && Array.isArray(schema.enum)) result.enum = structuredClone(schema.enum);
    if (!sensitive && Object.hasOwn(schema, "const")) result.const = structuredClone(schema.const);
    if (schema.format !== undefined) result.format = schema.format;
    if (schema.minLength !== undefined) result.minLength = schema.minLength;
    if (typeof schema.maxItems === "number") result.maxItems = schema.maxItems;
    if (schema.type === "object") {
      result.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Reserved schema field");
        return [key, visit(child as Record<string, unknown>, sensitive || isSecretField(key), depth + 1)];
      }));
      if (schema.required) result.required = [...schema.required];
      if (schema.additionalProperties !== undefined) result.additionalProperties = typeof schema.additionalProperties === "boolean" ? schema.additionalProperties : visit(schema.additionalProperties, sensitive, depth + 1);
    }
    if (schema.type === "array" && schema.items) result.items = visit(schema.items, sensitive, depth + 1);
    return result;
  };
  try { return visit(raw); } catch { return undefined; }
}
