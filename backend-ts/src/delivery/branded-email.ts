import type { ErpbridgeMcpSdkTool } from "../tools/erpbridge-mcp-client.js";

export const EMAIL_TEMPLATE_PROFILE = "workflow-email/v1";
export const EMAIL_LOGO_URL = "https://workflow-automation-44201.web.app/brand/agentic-email-mark.png";
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(value => value.trim());
const separator = (line: string) => /^\s*[-:]+(?:\s*[|+]\s*[-:]+)+\s*$/.test(line.replace(/^\s*\|/, "").replace(/\|\s*$/, ""));
const numeric = (value: string) => /^\(?[-+]?\d[\d\s,.%]*\)?$/.test(value.trim());

/** Presentation only: all values are escaped text, never model HTML. The
 * original text remains the MIME alternative; no facts/totals are generated.
 * Inline styles and layout tables work without JS, fonts, or external CSS. */
export function renderBrandedEmail(subject: string, text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(`<p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#334155;white-space:pre-line;overflow-wrap:anywhere">${paragraph.map(escapeHTML).join("\n")}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) { flush(); continue; }
    const headers = cells(line);
    if (line.includes("|") && headers.length > 1 && separator(lines[index + 1] ?? "")) {
      const rows: string[][] = [];
      let next = index + 2;
      while (next < lines.length && lines[next]!.includes("|") && cells(lines[next]!).length === headers.length) rows.push(cells(lines[next++]!));
      if (rows.length) {
        flush();
        const headerHTML = headers.map(value => `<th scope="col" style="padding:12px 10px;background:#f5eef4;border-bottom:2px solid #e4d3e1;text-align:left;font-size:12px;font-weight:700;color:#631354;vertical-align:top">${escapeHTML(value)}</th>`).join("");
        const rowHTML = rows.map((row, rowIndex) => `<tr>${row.map(value => `<td style="padding:11px 10px;border-bottom:1px solid #e2e8f0;background:${rowIndex % 2 ? "#f8fafc" : "#ffffff"};text-align:${numeric(value) ? "right" : "left"};font-size:13px;line-height:1.5;color:#334155;vertical-align:top;overflow-wrap:anywhere">${escapeHTML(value)}</td>`).join("")}</tr>`).join("");
        blocks.push(`<div style="margin:0 0 24px;overflow-x:auto"><table aria-label="Report details" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0"><thead><tr>${headerHTML}</tr></thead><tbody>${rowHTML}</tbody></table></div>`);
        index = next - 1; continue;
      }
    }
    if (/^#{1,3}\s+/.test(line)) {
      flush(); blocks.push(`<h2 style="margin:26px 0 12px;font-size:17px;line-height:1.4;font-weight:700;color:#0f172a">${escapeHTML(line.replace(/^#{1,3}\s+/, ""))}</h2>`);
    } else paragraph.push(line);
  }
  flush();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(subject)}</title></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f1f5f9"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="720" cellpadding="0" cellspacing="0" style="width:100%;max-width:720px;background:#ffffff;border-top:4px solid #84006a"><tr><td style="padding:24px 28px;border-bottom:1px solid #e2e8f0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:12px"><img src="${EMAIL_LOGO_URL}" width="44" height="44" alt="Workflow Automation" style="display:block;width:44px;height:44px;border:0"></td><td style="font-size:18px;font-weight:700;color:#0f172a">Workflow Automation<br><span style="font-size:12px;font-weight:400;color:#64748b">Business updates</span></td></tr></table></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 22px;font-size:23px;line-height:1.35;font-weight:700;color:#0f172a">${escapeHTML(subject)}</h1>${blocks.join("")}</td></tr><tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;font-size:11px;line-height:1.6;color:#64748b">Prepared in Workflow Automation.</td></tr></table></td></tr></table></body></html>`;
}

/** Recognize supported email semantics from the current live contract, not a
 * hard-coded ERP tool selector. Formatting happens BEFORE exact review/hash.
 * Plain-only connectors and non-email actions are left completely unchanged. */
export function formatEmailArguments(tool: ErpbridgeMcpSdkTool, args: Record<string, unknown>): Record<string, unknown> {
  if (!supportsBrandedEmail(tool, args)) return structuredClone(args);
  return { ...structuredClone(args), html: renderBrandedEmail(args.subject as string, args.text as string) };
}

function supportsBrandedEmail(tool: ErpbridgeMcpSdkTool, args: Record<string, unknown>): boolean {
  const properties = tool.inputSchema.properties as Record<string, { type?: unknown }> | undefined;
  return tool.annotations?.readOnlyHint !== true && /\b(?:email|mail)\b/i.test(`${tool.name.replace(/[_-]/g, " ")} ${tool.description ?? ""}`) &&
    !!properties?.to && properties.html?.type === "string" && properties.text?.type === "string" && properties.subject?.type === "string" &&
    typeof args.subject === "string" && typeof args.text === "string" && !!args.text.trim();
}

export function hasVerifiedBrandedEmail(tool: ErpbridgeMcpSdkTool, args: Record<string, unknown>): boolean {
  return supportsBrandedEmail(tool, args) && typeof args.html === "string" &&
    args.html === renderBrandedEmail(args.subject as string, args.text as string);
}
