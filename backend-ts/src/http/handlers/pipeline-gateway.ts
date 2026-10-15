import { createHmac } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDefinition } from "../generated-routes.js";
import {
  appendAudit,
  HandlerFailure,
  isRecord,
  requestParam,
  stringValue,
  type CurrentUser,
  type HandlerServices,
} from "./common.js";

export const PIPELINE_GATEWAY_UNHANDLED = Symbol("pipeline-gateway-unhandled");

const DOCUMENT_FIELDS = new Set([
  "source_system_id",
  "source_entity",
  "parent_record_id",
  "business_key_name",
  "business_key_value",
  "document_type",
  "sensitivity",
]);
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;

type BufferedUpload = {
  form: FormData;
  filenameHash: string;
  sizeBytes: number;
  metadata: Record<string, string>;
};

/**
 * Trusted browser-to-pipeline boundary. The browser is authenticated by this
 * application; only this server receives the pipeline API key.
 */
export async function handlePipelineGatewayRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof PIPELINE_GATEWAY_UNHANDLED> {
  const base = `${services.config.apiBasePath}/pipeline/v1`;
  if (!route.path.startsWith(`${services.config.apiBasePath}/pipeline/`))
    return PIPELINE_GATEWAY_UNHANDLED;

  const pipelineBaseURL = services.config.pipelineAPIBaseURL?.trim() ?? "";
  const pipelineAPIKey = services.config.pipelineAPIKey?.trim() ?? "";
  if (!pipelineBaseURL || !pipelineAPIKey)
    throw new HandlerFailure(503, "The data-transformation pipeline is not configured", {
      code: "PIPELINE_UNAVAILABLE",
    });

  if (route.method === "GET" && route.path === `${base}/health/ready`)
    return proxyJSON(reply, services, pipelineBaseURL, pipelineAPIKey, "/v1/health/ready");

  if (route.method === "GET" && route.path === `${base}/jobs/:id`)
    return proxyJSON(
      reply,
      services,
      pipelineBaseURL,
      pipelineAPIKey,
      `/v1/jobs/${encodeURIComponent(requestParam(request, "id"))}`,
    );

  const isCSV = route.method === "POST" && route.path === `${base}/files/csv`;
  const isDocument = route.method === "POST" && route.path === `${base}/files/documents`;
  if (!isCSV && !isDocument) return PIPELINE_GATEWAY_UNHANDLED;
  if (isDocument && !user.permissions.includes("registry:write"))
    throw new HandlerFailure(403, "Legacy document ingestion is administrator-only. Use chat Documents & forms for private, reviewed uploads.", { code: "LEGACY_INGESTION_ADMIN_REQUIRED" });
  if (!request.isMultipart())
    throw new HandlerFailure(400, "Choose a supported file to upload", { code: "PIPELINE_FILE_REQUIRED" });

  const upload = await bufferUpload(request, isDocument ? DOCUMENT_FIELDS : new Set(), services.config.jwtSecret);
  const auditDigest = (value: string) => createHmac("sha256", services.config.jwtSecret).update(`business-key:${value}`).digest("hex");
  const auditDetails = {
    kind: isDocument ? "document" : "tabular",
    filenameHash: upload.filenameHash,
    sizeBytes: upload.sizeBytes,
    sourceSystemId: upload.metadata.source_system_id ?? null,
    sourceEntity: upload.metadata.source_entity ?? null,
    documentType: upload.metadata.document_type ?? null,
    sensitivity: upload.metadata.sensitivity ?? null,
    businessKeyHash: upload.metadata.business_key_value
      ? auditDigest(upload.metadata.business_key_value)
      : null,
  };

  // Persist authority and an audit request before the external mutation. If
  // storage is unavailable, no bytes are sent to the pipeline.
  await services.repository.mutate((state) =>
    appendAudit(state, user, "pipeline.upload.requested", "pipeline_upload", upload.filenameHash, null, auditDetails, request),
  );

  const result = await pipelineFetch(
    services,
    pipelineBaseURL,
    pipelineAPIKey,
    isDocument ? "/v1/files/documents" : "/v1/files/csv",
    { method: "POST", body: upload.form },
  );

  if (result.response.ok && isRecord(result.payload)) {
    const payload = result.payload;
    const uploadID = stringValue(payload.upload_id) || upload.filenameHash;
    try {
      await services.repository.mutate((state) =>
        appendAudit(state, user, "pipeline.upload.completed", "pipeline_upload", uploadID, auditDetails, {
          ...auditDetails,
          uploadId: uploadID,
          contentHash: stringValue(payload.content_hash) || null,
          indexJobId: stringValue(payload.index_job_id ?? payload.schema_index_job_id) || null,
        }, request),
      );
    } catch {
      // The upstream result is already authoritative and must not be hidden in
      // a way that encourages a duplicate upload. The pre-dispatch audit stays.
      void reply.header("x-audit-status", "requested-only");
    }
  }

  return reply.status(result.response.status).send(result.payload);
}

export async function bufferUpload(request: FastifyRequest, allowedFields: ReadonlySet<string>, auditKey: string): Promise<BufferedUpload> {
  const form = new FormData();
  const metadata: Record<string, string> = {};
  let fileSeen = false;
  let filenameHash = "";
  let sizeBytes = 0;

  for await (const part of request.parts(allowedFields.has("idempotency_key") ? { limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 1, parts: 2 } } : {})) {
    if (part.type === "file") {
      if (fileSeen || part.fieldname !== "file")
        throw new HandlerFailure(400, "Exactly one file field is required", { code: "PIPELINE_FILE_INVALID" });
      const bytes = await part.toBuffer();
      if (allowedFields.has("idempotency_key") && bytes.length > 16 * 1024 * 1024)
        throw new HandlerFailure(413, "The attachment limit is 16 MiB");
      if (bytes.length === 0)
        throw new HandlerFailure(422, "The selected file is empty", { code: "PIPELINE_FILE_EMPTY" });
      fileSeen = true;
      sizeBytes = bytes.length;
      filenameHash = createHmac("sha256", auditKey).update(`filename:${part.filename}`).digest("hex");
      form.append("file", new Blob([bytes], { type: part.mimetype || "application/octet-stream" }), part.filename);
      continue;
    }

    if (!allowedFields.has(part.fieldname))
      throw new HandlerFailure(400, `Unsupported upload field ${JSON.stringify(part.fieldname)}`, { code: "PIPELINE_FIELD_INVALID" });
    if (Object.hasOwn(metadata, part.fieldname))
      throw new HandlerFailure(400, `Upload field ${JSON.stringify(part.fieldname)} was supplied more than once`, { code: "PIPELINE_FIELD_DUPLICATE" });
    const value = typeof part.value === "string" ? part.value.trim() : "";
    if (value.length > 500)
      throw new HandlerFailure(422, `Upload field ${JSON.stringify(part.fieldname)} is too long`, { code: "PIPELINE_FIELD_TOO_LONG" });
    if (value) {
      metadata[part.fieldname] = value;
      form.append(part.fieldname, value);
    }
  }

  if (!fileSeen)
    throw new HandlerFailure(400, "Choose a supported file to upload", { code: "PIPELINE_FILE_REQUIRED" });
  return { form, filenameHash, sizeBytes, metadata };
}

async function proxyJSON(
  reply: FastifyReply,
  services: HandlerServices,
  baseURL: string,
  apiKey: string,
  path: string,
): Promise<unknown> {
  const result = await pipelineFetch(services, baseURL, apiKey, path, { method: "GET" });
  return reply.status(result.response.status).send(result.payload);
}

async function pipelineFetch(
  services: HandlerServices,
  baseURL: string,
  apiKey: string,
  path: string,
  init: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  let response: Response;
  try {
    response = await fetch(new URL(path, baseURL), {
      ...init,
      headers: { Accept: "application/json", "X-API-Key": apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(services.config.pipelineTimeoutMs ?? 180_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new HandlerFailure(504, "The data-transformation pipeline timed out", { code: "PIPELINE_TIMEOUT" });
    throw new HandlerFailure(502, "The data-transformation pipeline could not be reached", { code: "PIPELINE_UNREACHABLE" });
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE_BYTES)
    throw new HandlerFailure(502, "The data-transformation pipeline returned an oversized response", { code: "PIPELINE_RESPONSE_TOO_LARGE" });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_UPSTREAM_RESPONSE_BYTES)
    throw new HandlerFailure(502, "The data-transformation pipeline returned an oversized response", { code: "PIPELINE_RESPONSE_TOO_LARGE" });
  try {
    return { response, payload: text ? JSON.parse(text) : null };
  } catch {
    throw new HandlerFailure(502, "The data-transformation pipeline returned an invalid response", { code: "PIPELINE_RESPONSE_INVALID" });
  }
}
