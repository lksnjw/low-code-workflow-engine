import { test, expect } from "@jest/globals";
import { erpActionLabel, erpActionFields } from "./erpActionPresentation";

test.each([["create_customer", "Create customer"], ["create_stock_entry", "Create stock entry"], ["constructor_customer", "ERP change"], ["unknown.operation", "ERP change"]])("business heading for %s is conservative", (toolName, expected) => {
  expect(erpActionLabel({ toolName, arguments: {} })).toBe(expected);
});
test("a customer update decodes only the known JSON-string wrapper for display without changing the approved payload", () => {
  const action = { toolName: "update_document", arguments: Object.freeze({ doctype: "Customer", name: "QA-1", fieldname: '{"customer_details":"Reviewed description"}' }) };
  expect(erpActionLabel(action)).toBe("Update customer");
  expect(erpActionFields(action)).toEqual({ record_type: "Customer", record: "QA-1", changes: { customer_details: "Reviewed description" } });
  expect(action.arguments.fieldname).toBe('{"customer_details":"Reviewed description"}');
});
test.each(["not JSON", "[]", '{"__proto__":{}}'])('unsupported wrapper %s is retained verbatim, not reinterpreted', fieldname => {
  const action = { toolName: "update_document", arguments: { doctype: "Customer", name: "QA-1", fieldname } };
  expect(erpActionFields(action)).toBe(action.arguments);
});
test("other fields cannot overwrite the displayed exact change", () => {
  const action = { toolName: "update_document", arguments: { fieldname: '{"phone":"123"}', changes: "different" } };
  expect(erpActionFields(action)).toMatchObject({ changes: { phone: "123" }, other_fields: { changes: "different" } });
});

test("provider-qualified email labels do not change the approved recipient, body or replay identity", () => {
  const args = Object.freeze({ to: ["recipient@example.test"], from: "support@example.test", cc: ["finance@example.test"], subject: "Orders", text: "Reviewed details", idempotency_key: "same-exact-identity" });
  const action = { toolName: "resend-email-send", arguments: args };
  expect(erpActionLabel(action)).toBe("Send email");
  expect(erpActionFields(action)).toEqual({ to: args.to, from: args.from, cc: args.cc, subject: args.subject, text: args.text });
  expect(action.arguments.idempotency_key).toBe("same-exact-identity");
});

test("email markup stays in exact technical arguments while ordinary review retains recipients, text and attachment fields", () => {
  const args = Object.freeze({ to: ["recipient@example.test"], from: "sender@example.test", subject: "Orders", text: "Reviewed message",
    html: "<html><body>Reviewed message</body></html>", attachments: [{ filename: "orders.pdf" }], idempotency_key: "fixed-key" });
  const result = erpActionFields({ toolName: "resend-email-send", arguments: args });
  expect(result.html).toBeUndefined(); expect(result.html_message).toContain("Technical details");
  expect(result).toMatchObject({ to: args.to, from: args.from, text: args.text, subject: args.subject, attachments: args.attachments });
  expect(args.html).toBe("<html><body>Reviewed message</body></html>"); expect(args.idempotency_key).toBe("fixed-key");
});
