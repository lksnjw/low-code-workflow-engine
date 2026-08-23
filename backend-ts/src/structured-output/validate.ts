export function validateSchema(schema: unknown): string[] {
  const errors: string[] = [];
  inspectSchema(schema, "$", errors);
  return errors;
}

export function validateValue(schema: unknown, value: unknown): string[] {
  const schemaErrors = validateSchema(schema);
  if (schemaErrors.length > 0) return schemaErrors;
  const errors: string[] = [];
  inspectValue(schema as Record<string, unknown>, value, "$", errors);
  return errors;
}

function inspectSchema(schema: unknown, path: string, errors: string[]): void {
  if (!isRecord(schema)) { errors.push(`${path}: schema must be an object`); return; }
  const type = schema.type;
  if (typeof type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type)) errors.push(`${path}.type: unsupported or missing schema type`);
  if (type === "object") {
    if (schema.properties !== undefined && !isRecord(schema.properties)) errors.push(`${path}.properties: must be an object`);
    if (isRecord(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) inspectSchema(child, `${path}.properties.${key}`, errors);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))) errors.push(`${path}.required: must be an array of strings`);
  }
  if (type === "array") {
    if (schema.items === undefined) errors.push(`${path}.items: is required for arrays`); else inspectSchema(schema.items, `${path}.items`, errors);
  }
}

function inspectValue(schema: Record<string, unknown>, value: unknown, path: string, errors: string[]): void {
  const type = schema.type;
  if (type === "null") { if (value !== null) errors.push(`${path}: expected null`); return; }
  if (type === "string") { if (typeof value !== "string") errors.push(`${path}: expected string`); return; }
  if (type === "boolean") { if (typeof value !== "boolean") errors.push(`${path}: expected boolean`); return; }
  if (type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected number`); return; }
  if (type === "integer") { if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer`); return; }
  if (type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
    value.forEach((item, index) => inspectValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`, errors));
    return;
  }
  if (type === "object") {
    if (!isRecord(value)) { errors.push(`${path}: expected object`); return; }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: is required`);
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key];
      if (child !== undefined) inspectValue(child as Record<string, unknown>, item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property is not allowed`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
