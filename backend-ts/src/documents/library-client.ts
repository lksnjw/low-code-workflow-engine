import { createHmac } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { DispatchIdentity } from "../tools/registry.js";
import type { AppConfig } from "../config/config.js";
import { HandlerFailure, isRecord, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";

export const LIBRARY_READ_TOOLS = new Set(["pipeline-library-discover", "pipeline-library-search", "pipeline-library-resolve"]);
export function libraryModelInputSchema(tool: Pick<ToolDefinition, "input_schema" | "mcp_tool_name">): Record<string, unknown> {
  const schema = structuredClone(tool.input_schema ?? { type: "object", properties: {} });
  if (!LIBRARY_READ_TOOLS.has(tool.mcp_tool_name)) return schema;
  if (isRecord(schema.properties)) delete schema.properties.access_token;
  if (Array.isArray(schema.required)) schema.required = schema.required.filter(key => key !== "access_token");
  return schema;
}
const delegations = new WeakMap<object, { contract: Buffer; args: Buffer; actorId: string; role: string; issue: () => string }>();

/** Private one-use transport authority; never authored workflow parameters. */
export function bindLibraryReadDelegation(config: AppConfig, user: Pick<CurrentUser, "id" | "role" | "permissions">, tool: ToolDefinition, args: Record<string, unknown>): object {
  if (!tool.is_read_only || !tool.bridge_contract || !LIBRARY_READ_TOOLS.has(tool.mcp_tool_name) || Object.hasOwn(args, "access_token"))
    throw new Error("Private document delegation requires an exact reviewed read contract and server-owned scope");
  const ticket = Object.freeze({});
  const principal = structuredClone(user), binding = { pipelineAPIKey: config.pipelineAPIKey ?? "", pipelineWorkspaceId: config.pipelineWorkspaceId ?? "lcwe" };
  delegations.set(ticket, { contract: canonicalJSONBytes(tool), args: canonicalJSONBytes(args), actorId: user.id, role: user.role,
    issue: () => libraryScope(binding, principal, true) });
  return ticket;
}

export function consumeLibraryReadDelegation(ticket: object, tool: ToolDefinition, args: Record<string, unknown>, identity: DispatchIdentity): string {
  const delegation = delegations.get(ticket); delegations.delete(ticket);
  if (!delegation || !delegation.contract.equals(canonicalJSONBytes(tool)) || !delegation.args.equals(canonicalJSONBytes(args)) ||
      delegation.actorId !== identity.userId || delegation.role !== identity.localRole)
    throw new Error("Private document delegation is not authentic for this exact invocation");
  return delegation.issue();
}

/** A bounded delegation, never the service credential; authority is server-owned. */
export function libraryScope(config: Pick<AppConfig, "pipelineAPIKey" | "pipelineWorkspaceId">, user: Pick<CurrentUser, "id" | "role" | "permissions">, readOnly = false): string {
  if (!config.pipelineAPIKey) throw new HandlerFailure(503, "The document pipeline credential is not configured");
  const iat = Math.floor(Date.now() / 1000);
  const raw = Buffer.from(JSON.stringify({ profile: "pipeline-library-scope/v1", workspaceId: config.pipelineWorkspaceId ?? "lcwe",
    actorId: user.id, role: user.role, canManage: !readOnly && user.permissions.includes("registry:write"),
    canUpload: !readOnly && user.permissions.includes("pipeline:upload"), readOnly, iat, exp: iat + 120 })).toString("base64url");
  return `${raw}.${createHmac("sha256", config.pipelineAPIKey).update(raw).digest("base64url")}`;
}

export async function libraryRequest(services: Pick<HandlerServices, "config"> & { repository: { assertAuthority?: () => void } }, user: CurrentUser, path: string,
  options: { method?: string; body?: unknown; form?: FormData; readOnly?: boolean; maxResponseBytes?: number; timeoutMs?: number; signal?: AbortSignal | undefined } = {}): Promise<Record<string, any>> {
  if (!services.config.pipelineAPIBaseURL || !services.config.pipelineAPIKey)
    throw new HandlerFailure(503, "The document pipeline is not configured", { code: "PIPELINE_UNAVAILABLE" });
  services.repository.assertAuthority?.();
  const timeoutMs = options.timeoutMs ?? services.config.pipelineTimeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("Invalid document pipeline deadline");
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  if (signal.aborted) throw new HandlerFailure(409, "Document request cancelled");
  const handoffTimeout = () => new HandlerFailure(504, "Document storage was not confirmed before the handoff deadline. A timed-out upload may still exist: refresh attachments and reuse its original request identity before retrying.", { code: "PIPELINE_HANDOFF_TIMEOUT" });
  let response: Response;
  try {
    response = await fetch(new URL(`/v1/library${path}`, services.config.pipelineAPIBaseURL), {
      method: options.method ?? "GET", redirect: "error", signal,
      headers: { Accept: "application/json", "X-API-Key": services.config.pipelineAPIKey, "X-Library-Scope": libraryScope(services.config, user, options.readOnly),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.form ? { body: options.form } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    if (options.signal?.aborted) throw new HandlerFailure(409, "Document request cancelled");
    if (options.readOnly && deadline.aborted) throw new HandlerFailure(504, "Document retrieval timed out. No new result was confirmed.", { code: "PIPELINE_READ_TIMEOUT" });
    if (options.timeoutMs !== undefined && deadline.aborted) throw handoffTimeout();
    throw new HandlerFailure(502, "The document pipeline could not be reached. Refresh attachments before retrying an upload or confirmation.", { code: "PIPELINE_UNREACHABLE" });
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > (options.maxResponseBytes ?? 2 * 1024 * 1024)) { await reader.cancel(); throw new Error("limit"); }
        chunks.push(next.value);
      }
    } catch { if (options.signal?.aborted) throw new HandlerFailure(409, "Document request cancelled"); if (options.readOnly && deadline.aborted) throw new HandlerFailure(504, "Document retrieval timed out. No new result was confirmed.", { code: "PIPELINE_READ_TIMEOUT" }); if (options.timeoutMs !== undefined && deadline.aborted) throw handoffTimeout(); throw new HandlerFailure(502, "The document pipeline response was incomplete or too large. Refresh before retrying."); }
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HandlerFailure(502, "The document pipeline returned an invalid response"); }
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    throw new HandlerFailure(response.status, typeof error.message === "string" ? error.message : "The document operation failed", { code: error.code ?? "PIPELINE_FAILED" });
  }
  if (!isRecord(payload)) throw new HandlerFailure(502, "The document pipeline returned an invalid receipt");
  return payload;
}

/** Explicit private-response projection. Source content is fetched only for review. */
export function publicAttachment(upload: Record<string, any>): Record<string, any> {
  const { text: _text, file_base64: _file, data_base64: _source, extracted_text: _extracted, commit_fingerprint: _fingerprint, ...publicFields } = upload;
  if (isRecord(publicFields.proposal) && Array.isArray(publicFields.proposal.choices))
    publicFields.proposal = { ...publicFields.proposal, choices: publicFields.proposal.choices.map((choice: Record<string, unknown>) => {
      const { readReceipt: _receipt, ...visible } = choice; return visible;
    }) };
  return publicFields;
}
