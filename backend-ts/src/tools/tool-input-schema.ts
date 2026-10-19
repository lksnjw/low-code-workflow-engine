import { validateSchema, validateValue } from "../structured-output/validate.js";

// Explicit, bounded phase-0 JSON Schema profile. Unknown constraints block
// dispatch rather than silently passing through a partial validator.
const allowed = new Set(["type", "enum", "const", "format", "minLength", "properties", "required", "additionalProperties", "items", "maxItems", "$schema", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
// Some connected ToolPlane functions publish unconstrained JSON fields as
// type:"". Keep that exact remote contract pinned; interpret this explicit
// legacy marker as JSON, never as an invented scalar type or an instruction.
function extended(schema: unknown): boolean {
  if (!record(schema)) return false;
  return schema.type === "" || schema.type === undefined || "const" in schema || "format" in schema || "minLength" in schema ||
    Array.isArray(schema.type) && schema.type.some((type: unknown) => type === "object" || type === "array") ||
    record(schema.additionalProperties) || Object.values(schema.properties ?? {}).some(extended) || (schema.items !== undefined && extended(schema.items));
}
export function validateToolSchemaProfile(schema: unknown): string[] {
  let nodes = 0;
  const errors: string[] = [];
  function inspect(input: unknown, depth: number): void {
    if (++nodes > 512 || depth > 16) { errors.push("Tool schema exceeds supported limits"); return; }
    if (input === null || typeof input !== "object" || Array.isArray(input)) { errors.push("Unsupported tool schema"); return; }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowed.has(key))) errors.push("Tool schema contains unsupported constraints");
    if (record.properties !== undefined && !isSchema(record.properties)) errors.push("Tool schema properties must be an object");
    if (("properties" in record || "required" in record || "additionalProperties" in record) && record.type !== "object") errors.push("Object constraints require object type");
    if ("items" in record && record.type !== "array") errors.push("Items require array type");
    if ("maxItems" in record && (record.type !== "array" || !Number.isInteger(record.maxItems) || Number(record.maxItems) < 0 || Number(record.maxItems) > 100_000)) errors.push("maxItems requires an array and an integer from 0 to 100000");
    if ("additionalProperties" in record && typeof record.additionalProperties !== "boolean" && !isSchema(record.additionalProperties)) errors.push("Invalid additionalProperties schema");
    if (isSchema(record.additionalProperties)) inspect(record.additionalProperties, depth + 1);
    const declared = Array.isArray(record.type) ? record.type : record.type === undefined || record.type === "" ? [] : [record.type];
    if (declared.some(type => !types.has(String(type))) || new Set(declared).size !== declared.length || Array.isArray(record.type) && !declared.length) errors.push("Unsupported tool schema type");
    if (record.enum !== undefined && (!Array.isArray(record.enum) || !record.enum.length || record.enum.length > 128 || record.enum.some(value => value !== null && !["string", "number", "boolean"].includes(typeof value)))) errors.push("Unsupported tool schema enum");
    if (record.const !== undefined && record.const !== null && !["string", "number", "boolean"].includes(typeof record.const)) errors.push("Unsupported tool schema const");
    if (record.format !== undefined && (record.format !== "date-time" || record.type !== "string")) errors.push("Unsupported tool schema format");
    if (record.minLength !== undefined && (record.type !== "string" || !Number.isInteger(record.minLength) || Number(record.minLength) < 0)) errors.push("Unsupported minLength");
    if (record.required !== undefined && (!Array.isArray(record.required) || !record.required.every(key => typeof key === "string"))) errors.push("Invalid required fields");
    if (record.properties !== null && typeof record.properties === "object" && !Array.isArray(record.properties)) {
      const children = Object.values(record.properties);
      if (children.length > 128) { errors.push("Too many tool schema properties"); return; }
      for (const child of children) inspect(child, depth + 1);
    }
    if ("items" in record) inspect(record.items, depth + 1);
  }
  inspect(schema, 0);
  return errors.length ? errors : extended(schema) ? [] : validateSchema(schema);
}

const isSchema = (value: unknown): value is Record<string, unknown> => record(value);
function extendedValue(schema: Record<string, any>, value: unknown, path = "$", errors: string[] = []): string[] {
  const declared = Array.isArray(schema.type) ? schema.type : schema.type === undefined || schema.type === "" ? [] : [schema.type];
  const matches = (type: string) => type === "object" ? record(value) : type === "array" ? Array.isArray(value) : type === "null" ? value === null :
    type === "integer" ? typeof value === "number" && Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type;
  if (declared.length && !declared.some(matches)) { errors.push(`${path}: expected ${declared.join(" or ")}`); return errors; }
  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => equal(item, value))) errors.push(`${path}: value is outside the declared enum`);
  if (Object.hasOwn(schema, "const") && !equal(schema.const, value)) errors.push(`${path}: value differs from the declared const`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: below minLength`);
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))) errors.push(`${path}: expected date-time`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path}: exceeds maxItems`);
    if (schema.items) value.forEach((item, index) => extendedValue(schema.items, item, `${path}[${index}]`, errors));
  } else if (record(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: is required`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) extendedValue(child, item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property is not allowed`);
      else if (isSchema(schema.additionalProperties)) extendedValue(schema.additionalProperties, item, `${path}.${key}`, errors);
    }
  }
  return errors;
}

export function validateToolInput(schema: unknown, value: unknown): string[] {
  const errors = validateToolSchemaProfile(schema);
  let nodes = 0;
  function inspectValue(item: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 16) { errors.push("Tool arguments exceed supported limits"); return; }
    if (item === null || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) errors.push("Tool arguments contain reserved keys");
      inspectValue(child, depth + 1);
      if (nodes > 4096) break;
    }
  }
  inspectValue(value, 0);
  return errors.length ? errors : extended(schema) ? extendedValue(schema as Record<string, any>, value) : validateValue(schema, value);
}
