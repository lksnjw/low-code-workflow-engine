import { z } from "zod";
import { libraryRequest } from "./library-client.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { evaluateOptionalPolicy } from "../governance/optional-policy.js";
import type { ErpbridgeMcpSdkTool } from "../tools/erpbridge-mcp-client.js";

// Code-owned backend skills, not arbitrary HTTP tools or ERP role grants.
const inputs = {
  "pipeline-library-discover": z.object({}).strict(),
  "pipeline-library-search": z.object({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(20).optional() }).strict(),
  "pipeline-library-resolve": z.object({ document_id: z.string().trim().min(1).max(200) }).strict(),
};
export function directLibraryConfigured(services: Pick<HandlerServices, "config">): boolean {
  return Boolean(services.config.pipelineAPIBaseURL && services.config.pipelineAPIKey);
}
export function directLibraryCatalog(services: Pick<HandlerServices, "config">): ErpbridgeMcpSdkTool[] {
  if (!directLibraryConfigured(services)) return [];
  const descriptions = {
    "pipeline-library-discover": "Discover my permitted uploaded documents, entity schemas, collection routes and summary counts. Backend document library; no ERPBridge required. This does not upload or create ERP records.",
    "pipeline-library-search": "Search my stored document text, registration forms, images and PDFs in the vector database. Use a person's or customer's name or reference. Returns document identifiers; resolve a match before using its fields. Not an exact inventory count.",
    "pipeline-library-resolve": "Retrieve a current permitted saved document by document_id, including extracted text, reviewed fields, source entity and version. Backend document library; not an ERP creation receipt.",
  };
  // Keep the model declaration in the engine's supported schema profile.
  // The stricter code-owned Zod schemas above enforce lengths/ranges at entry.
  const schemas: Record<string, Record<string, unknown>> = {
    "pipeline-library-discover": { type: "object", properties: {}, additionalProperties: false },
    "pipeline-library-search": { type: "object", properties: { query: { type: "string", description: "A search phrase, 1–2000 characters" }, limit: { type: "integer", description: "1–20 matches, defaults to 10" } }, required: ["query"], additionalProperties: false },
    "pipeline-library-resolve": { type: "object", properties: { document_id: { type: "string", description: "A document identifier returned by saved receipt or search" } }, required: ["document_id"], additionalProperties: false },
  };
  return Object.keys(inputs).map(name => ({ name, description: descriptions[name as keyof typeof descriptions],
    inputSchema: schemas[name]!, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }));
}

/** Actor/scope is freshly derived on the server. Model arguments can select
 * only a query or identifier; never a URL, credential, owner or collection. */
export async function dispatchDirectLibraryRead(services: HandlerServices, user: CurrentUser, sessionId: string, name: string,
  args: Record<string, unknown>, options: { signal?: AbortSignal | undefined; traceId?: string | undefined; beforeDispatch?: (() => Promise<void>) | undefined } = {}): Promise<Record<string, unknown>> {
  if (!Object.hasOwn(inputs, name)) throw new HandlerFailure(422, "Unknown document library skill");
  const parsed = inputs[name as keyof typeof inputs].safeParse(args);
  if (!parsed.success) throw new HandlerFailure(422, "Use the document skill's declared fields; access and storage scope are server-owned");
  const assertCurrent = () => services.repository.readAuthoritative(state => {
    services.repository.assertAuthority();
    assertChatAuthority(state, user, sessionId);
    if (options.signal?.aborted) throw new HandlerFailure(409, "Document request cancelled");
  });
  await assertCurrent();
  const policy = await evaluateOptionalPolicy(services, user, { prompt: `Read a permitted stored document using ${name}`, action: name,
    context: { arguments: parsed.data, readOnly: true }, sessionId, ...(options.traceId ? { traceId: options.traceId } : {}), signal: options.signal });
  if (policy.decision !== "allow") throw new HandlerFailure(409, policy.reason, { code: "DOCUMENT_POLICY_REVIEW_REQUIRED" });
  await assertCurrent();
  await options.beforeDispatch?.();
  await assertCurrent();
  const suffix = name.slice("pipeline-library-".length);
  const result = await libraryRequest(services, user, `/${suffix}`, { method: "POST", body: parsed.data, readOnly: true,
    timeoutMs: Math.min(15000, services.config.pipelineTimeoutMs ?? 15000), signal: options.signal });
  await assertCurrent();
  if (suffix === "resolve" && result.document_id !== (parsed.data as { document_id: string }).document_id)
    throw new HandlerFailure(502, "The pipeline returned a different document identity");
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
}
