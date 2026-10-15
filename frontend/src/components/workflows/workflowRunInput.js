export const runInputLabel = (key, schema = {}) => schema.title || String(key).replace(/[_-]+/g, " ").replace(/^./, value => value.toUpperCase());

/** Immediate guidance only. The exact current server schema remains authority. */
export function workflowRunInputIssues(schema, input, path = "", depth = 0) {
  if (!schema || depth > 8) return [];
  const issues = [], name = path || "Workflow input";
  if (schema.type === "object") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return [`${name} must be an object.`];
    for (const key of schema.required || []) if (!Object.hasOwn(input, key) || input[key] === undefined || input[key] === null || typeof input[key] === "string" && !input[key].trim()) issues.push(`${path ? path + " · " : ""}${runInputLabel(key, schema.properties?.[key])} is required.`);
    for (const [key, value] of Object.entries(input)) {
      if (schema.properties?.[key]) issues.push(...workflowRunInputIssues(schema.properties[key], value, `${path ? path + " · " : ""}${runInputLabel(key, schema.properties[key])}`, depth + 1));
      else if (schema.additionalProperties === false) issues.push(`${key} is not an allowed input.`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(input)) return [`${name} must be a list.`];
    if (input.length < (schema.minItems ?? 0) || input.length > (schema.maxItems ?? Infinity)) issues.push(`${name} has an invalid number of items.`);
    input.slice(0, 50).forEach((value, index) => issues.push(...workflowRunInputIssues(schema.items, value, `${name} · Item ${index + 1}`, depth + 1)));
  } else if (schema.type === "string") {
    if (typeof input !== "string") return [`${name} must be text.`];
    if (input.length < (schema.minLength ?? 0) || input.length > (schema.maxLength ?? Infinity)) issues.push(`${name} has an invalid length.`);
    if (schema.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(Date.parse(`${input}T00:00:00Z`)) || new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) !== input)) issues.push(`${name} must be a valid date.`);
  } else if (["number", "integer"].includes(schema.type)) {
    if (typeof input !== "number" || !Number.isFinite(input) || schema.type === "integer" && !Number.isSafeInteger(input)) issues.push(`${name} must be a valid ${schema.type}.`);
    else if (input < (schema.minimum ?? -Infinity) || input > (schema.maximum ?? Infinity)) issues.push(`${name} is outside the allowed range.`);
  } else if (schema.type === "boolean" && typeof input !== "boolean") issues.push(`${name} must be Yes or No.`);
  if (schema.enum && !schema.enum.some(value => Object.is(value, input))) issues.push(`${name} must use one of the available choices.`);
  return issues;
}
