import { validateToolInput } from "./tool-input-schema.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import type { ErpbridgeMcpSdkTool } from "./erpbridge-mcp-client.js";
import { hasVerifiedBrandedEmail } from "../delivery/branded-email.js";

/** Shared pre-dispatch validation. Defaults are hints, never permission to
 * invent missing business values. Keep JSON-string contracts byte-shaped. */
export function erpChatInputIssues(tool: ErpbridgeMcpSdkTool, args: Record<string, unknown>): string[] {
  // The legacy angle-bracket placeholder heuristic mistakes a full HTML
  // document for <missing_value>. Exempt only exact server-rendered output
  // from that heuristic; JSON Schema still validates the ORIGINAL arguments.
  const placeholderInput = hasVerifiedBrandedEmail(tool, args) ? { ...args, html: "Verified rendered email body" } : args;
  const runtime = validateToolArguments(tool.name, placeholderInput, { input_schema: tool.inputSchema });
  const issues = [...validateToolInput(tool.inputSchema, args), ...runtime.invalid, ...runtime.missing.map(key => `Missing required input: ${key}`)];
  const properties = tool.inputSchema.properties as Record<string, { type?: string; description?: string }> | undefined;
  for (const key of (tool.inputSchema.required ?? []) as string[]) {
    if (typeof args[key] === "string" && !(args[key] as string).trim()) issues.push(`Required input is blank: ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties?.[key];
    if (property?.type === "string" && typeof value === "string" && /\bjson\b/i.test(property.description ?? "")) {
      try {
        const decoded = JSON.parse(value);
        if (/\barray\b/i.test(property.description ?? "") && !Array.isArray(decoded)) issues.push(`${key} must contain a JSON array encoded as a string`);
        if (/\bobject\b/i.test(property.description ?? "") && !/\barray\b/i.test(property.description ?? "") && (!decoded || typeof decoded !== "object" || Array.isArray(decoded))) issues.push(`${key} must contain a JSON object encoded as a string`);
      } catch { issues.push(`${key} must contain valid JSON encoded as a string`); }
    }
  }
  return [...new Set(issues)];
}
