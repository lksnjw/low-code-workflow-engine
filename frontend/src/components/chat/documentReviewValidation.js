/** Immediate guidance only; the pipeline independently validates the exact
 * schema revision and values again before storing/indexing anything. */
export function documentReviewIssues(schema, fields, rows) {
  if (!schema) return [];
  const issues = [];
  const values = rows ?? [fields];
  if (!values.length) return ["Add at least one reviewed row."];
  if (values.length > 50) return ["Review no more than 50 rows at a time."];
  const names = new Set(schema.fields.map(field => field.name));
  values.forEach((row, index) => {
    const prefix = rows ? `Row ${index + 1}: ` : "";
    for (const name of Object.keys(row)) if (!names.has(name)) issues.push(`${prefix}${name} is not in the selected schema. Prepare a new review or select the correct schema.`);
    for (const field of schema.fields) {
      const value = row[field.name], label = `${prefix}${field.name}`;
      if (value === undefined || value === null || value === "" || typeof value === "string" && !value.trim()) {
        if (field.required && !field.generated) issues.push(`${label} is required.`);
        continue;
      }
      let valid = true;
      if (["string", "date", "email"].includes(field.type)) valid = typeof value === "string" && value.length <= 4000;
      if (field.type === "integer") valid = Number.isSafeInteger(value);
      if (field.type === "number") valid = typeof value === "number" && Number.isFinite(value);
      if (field.type === "boolean") valid = typeof value === "boolean";
      if (valid && field.type === "email") valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      if (valid && field.type === "date") {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
        valid = !!date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
      }
      if (!valid) issues.push(`${label} must be a valid ${field.type}${["string", "date", "email"].includes(field.type) ? " (up to 4,000 characters)" : ""}.`);
    }
  });
  return issues;
}
