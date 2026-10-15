const validEmail = value => typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);

/** Suggestions from the current tool contract, never invented or auto-selected.
 * Examples are not proof that a mailbox/domain is configured or verified. */
export function emailSenderOptions(tool) {
  const fields = tool?.inputSchema?.properties;
  if (tool?.annotations?.readOnlyHint === true || fields?.from?.type !== "string" || fields?.subject?.type !== "string" || !fields?.to || !fields?.text && !fields?.body) return null;
  const field = fields.from;
  const restricted = Array.isArray(field.enum);
  const values = restricted ? field.enum : [...(Array.isArray(field.examples) ? field.examples : []), ...(String(field.description || "").match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])];
  return { choices: [...new Set(values.filter(validEmail))].slice(0, 20), restricted };
}
