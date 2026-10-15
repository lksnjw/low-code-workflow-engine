import { expect, test } from "vitest";
import { renderBrandedEmail, formatEmailArguments, EMAIL_LOGO_URL } from "../src/delivery/branded-email.js";
import { BACKEND_ASSISTANT_SKILL_GUIDANCE } from "../src/agent/assistant-skills.js";
import { erpChatInputIssues } from "../src/tools/erp-chat-input.js";

const tool = { name: "provider-notification", description: "Send a business email", annotations: { readOnlyHint: false }, inputSchema: {
  type: "object", additionalProperties: false, properties: { to: { type: "array", items: { type: "string" } }, from: { type: "string" },
    subject: { type: "string" }, text: { type: "string" }, html: { type: "string" }, idempotency_key: { type: "string" }, reply_to: { type: "array", items: { type: "string" } } },
  required: ["from", "to", "subject", "text", "idempotency_key"] } };
const args = { to: ["recipient@example.test"], from: "support@example.test", subject: "Sales and purchase orders", idempotency_key: "stable-original-key",
  text: 'Please review these records.\n\n## Sales orders\n| Order | Customer | Total (LKR) |\n| --- | --- | ---: |\n| SO-1 | A & B | 20,000 |\n| SO-2 | Lakeview | 15,500 |\n\nCoverage: first two records only, not the full ERP count.' };

test("outgoing email has the existing logo, readable headings and actual aligned HTML tables", () => {
  const html = renderBrandedEmail(args.subject, args.text);
  expect(html).toContain(`<img src="${EMAIL_LOGO_URL}"`);
  expect(html).toContain("<h1"); expect(html).toContain("<h2"); expect(html).toContain('scope="col"');
  expect(html).toContain('aria-label="Report details"'); expect(html).toContain("text-align:right");
  expect(html).toContain("20,000"); expect(html).toContain("15,500"); expect(html).toContain("A &amp; B");
  expect(html).toContain("first two records only, not the full ERP count");
  expect(html).toContain('name="viewport"'); expect(html).toContain("max-width:720px");
  expect(html).not.toContain("---:"); expect(html).not.toContain("<script");
});

test("ASCII pipe-table emails also become real tables without generating totals", () => {
  const html = renderBrandedEmail("Order report", "Order | Supplier | Total\n------+----------+------\nPO-1 | Acme | 40,000\n\nCoverage unknown.");
  expect(html).toContain('aria-label="Report details"'); expect(html).toContain("PO-1");
  expect(html).toContain("40,000"); expect(html).toContain("Coverage unknown."); expect(html).not.toContain("Grand total");
});

test.each([
  'Name | Value\n---|---\nragged|row|preserved',
  'Heading | Value\n---|---',
  'Unrelated prose with | a pipe',
])("malformed/non-table text is retained, not silently lost: %s", body => {
  const html = renderBrandedEmail("Details", body);
  for (const line of body.split("\n")) expect(html).toContain(line);
});

test("all untrusted subject and body values are escaped, with no extra image, script or link requests", () => {
  const html = renderBrandedEmail('<img src="https://untrusted.invalid/subject">',
    '## <script>alert(1)</script>\n\n| Key | Value |\n|---|---|\n| <iframe> | <img src=x onerror=alert(1)> |\n\n<a href="https://untrusted.invalid/track">open</a>');
  expect(html).not.toMatch(/<script|<iframe|<a\s|onerror="|src="https:\/\/untrusted/);
  expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;iframe&gt;");
  expect(html.match(/<img /g)).toHaveLength(1);
});

test("Unicode business content is preserved", () => {
  const html = renderBrandedEmail("ගනුදෙනුකරුවන්", "## පාරිභෝගික තොරතුරු\nලක්ෂාන් — ඇතුළත් කිරීමට පෙර පරීක්ෂා කරන්න.");
  expect(html).toContain("ගනුදෙනුකරුවන්"); expect(html).toContain("ලක්ෂාන් —");
});

test("live schema-based formatting preserves all exact business/replay fields and the text alternative", () => {
  const source = { ...args, reply_to: ["reply@example.test"], html: '<script>model HTML is not trusted</script>' };
  const formatted = formatEmailArguments(tool, source);
  expect(formatted).toMatchObject(args); expect(formatted.reply_to).toEqual(source.reply_to);
  expect(formatted.text).toBe(args.text); expect(formatted.html).toBe(renderBrandedEmail(args.subject, args.text));
  expect(formatted.html).not.toContain("model HTML is not trusted"); expect(source.html).toContain("<script>");
  expect(erpChatInputIssues(tool, formatted)).toEqual([]);
  expect(formatEmailArguments(tool, formatted)).toEqual(formatted);
});

test.each(["resend-email-send", "resend-email-schedule", "resend-email-send-with-attachment", "another_provider.email_notify"])("formatting is not tied to one remote tool name: %s", name => {
  const input = { ...args, attachments: [{ filename: "report.pdf", content: "Zml4dHVyZQ==" }], scheduled_at: "2026-10-20T09:00:00+05:30" };
  const formatted = formatEmailArguments({ ...tool, name }, input);
  expect(formatted.html).toContain(EMAIL_LOGO_URL); expect(formatted.attachments).toEqual(input.attachments);
  expect(formatted.scheduled_at).toBe(input.scheduled_at); expect(formatted.idempotency_key).toBe(input.idempotency_key);
});

test("plain-text-only and non-email/read contracts stay unchanged", () => {
  const { html: _html, ...properties } = tool.inputSchema.properties;
  expect(formatEmailArguments({ ...tool, inputSchema: { ...tool.inputSchema, properties } }, args)).toEqual(args);
  expect(formatEmailArguments({ ...tool, name: "update_document", description: "Change document fields" }, args)).toEqual(args);
  expect(formatEmailArguments({ ...tool, annotations: { readOnlyHint: true } }, args)).toEqual(args);
});

test("the placeholder exception accepts only exact renderer output and never bypasses input schema constraints", () => {
  expect(erpChatInputIssues(tool, { ...args, html: "<missing_report>" })).not.toEqual([]);
  const safe = formatEmailArguments(tool, args);
  expect(erpChatInputIssues(tool, safe)).toEqual([]);
  expect(erpChatInputIssues(tool, { ...safe, html: String(safe.html).replace("Order report", "Other") + "<script>extra</script>" })).not.toEqual([]);
  const limited = { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, html: { type: "string", maxLength: 10 } } } };
  expect(erpChatInputIssues(limited, safe)).not.toEqual([]);
  expect(erpChatInputIssues(tool, { ...safe, to: "wrong-type@example.test" })).not.toEqual([]);
});

test("the application skill tells the model to compose the outgoing message and preserve confirmed evidence", () => {
  expect(BACKEND_ASSISTANT_SKILL_GUIDANCE).toContain("professional-email");
  expect(BACKEND_ASSISTANT_SKILL_GUIDANCE).toContain("actual outgoing message");
  expect(BACKEND_ASSISTANT_SKILL_GUIDANCE).toContain("Do not align columns with spaces");
  expect(BACKEND_ASSISTANT_SKILL_GUIDANCE).toContain("send confirmation unchanged");
});
