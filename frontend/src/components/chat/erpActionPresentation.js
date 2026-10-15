const plainWords = text => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Display only. Never mutate the exact backend-reviewed transaction. */
export function erpActionLabel(action) {
  const words = plainWords(String(action.toolName || "").split(/[.:/]/).at(-1) || "");
  // Provider-qualified notification names (for example resend-email-send)
  // are still shown in business language. Display only, never dispatch logic.
  if (words.includes("send") && words.some(word => ["email", "emails", "mail"].includes(word))) return "Send email";
  const verbs = { create: "Create", update: "Update", delete: "Delete", remove: "Remove", submit: "Submit", cancel: "Cancel", complete: "Complete", reopen: "Reopen", send: "Send", assign: "Assign" };
  const verb = Object.hasOwn(verbs, words[0]) ? verbs[words[0]] : undefined;
  if (!verb || words.length < 2) return "ERP change";
  let target = words.slice(1).join(" ");
  const recordType = action.arguments?.doctype;
  if (target === "document" && typeof recordType === "string" && /^[A-Za-z][A-Za-z -]{0,63}$/.test(recordType)) target = recordType.toLowerCase();
  return `${verb} ${target}`;
}

export function erpActionFields(action) {
  const args = action.arguments;
  if (erpActionLabel(action) === "Send email" && args && typeof args === "object" && !Array.isArray(args)) {
    // Keep replay identifiers under Technical details, not the message review.
    // All business fields, including cc/bcc and attachments, remain visible.
    // Source markup belongs with exact technical arguments, not thousands of
    // characters in the ordinary review. Keep the text alternative and make
    // the HTML's presence explicit; the immutable payload is never modified.
    const { idempotency_key: _idempotencyKey, html, ...fields } = args;
    return { ...fields, ...(html !== undefined ? { html_message: "HTML email included. Exact source is available in Technical details." } : {}) };
  }
  if (action.toolName !== "update_document" || !args || typeof args !== "object" || typeof args.fieldname !== "string") return args;
  // Decode only this known contract's JSON-string wrapper, never arbitrary
  // strings/HTML or a model-invented business transformation.
  if (args.fieldname.length > 16000 || !args.fieldname.trim().startsWith("{") || Object.hasOwn(args, "value")) return args;
  try {
    const changes = JSON.parse(args.fieldname);
    if (!changes || Array.isArray(changes) || typeof changes !== "object" || Object.keys(changes).length > 50 ||
      Object.keys(changes).some(key => ["__proto__", "constructor", "prototype"].includes(key))) return args;
    const { doctype, name, fieldname: _encodedChanges, ...remaining } = args;
    return { record_type: doctype, record: name, changes, ...(Object.keys(remaining).length ? { other_fields: remaining } : {}) };
  } catch { return args; }
}
