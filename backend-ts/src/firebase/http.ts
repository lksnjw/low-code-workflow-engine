import type { IncomingHttpHeaders } from "node:http";
import { fail } from "../models/schemas.js";
import { withFunctionRuntime, type FunctionComposition } from "./invocation.js";
import { FunctionServiceReadRequired, handleFunctionProgress, isFunctionProgressRequest } from "./progress-http.js";
import { FirestoreOwnershipFailure } from "../storage/firestore-writer-ownership.js";
import { handleFunctionChatCreation, isFunctionChatCreationRequest } from "./chat-creation-http.js";
import { handleFunctionChatCancellation, isFunctionChatCancellationRequest } from "./chat-cancellation-http.js";
import { handleFunctionControlPlane, isFunctionControlPlaneRequest } from "./control-plane-http.js";
import { handleFunctionPreflight } from "./preflight-http.js";

export type FunctionHttpRequest = { method: string; url: string; headers: IncomingHttpHeaders; rawBody?: Buffer; body?: unknown; ip?: string | undefined; signal?: AbortSignal };
export type FunctionHttpResponse = { statusCode: number; headers: Record<string, string | string[] | number | undefined>; body: Buffer };
const hopHeaders = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", "content-length", "host"]);
function response(statusCode: number, message: string, code: string): FunctionHttpResponse {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: Buffer.from(JSON.stringify(fail(message, { code }))) };
}

/** Closed admission-only route. No email delivery, synchronous operation or
 * arbitrary command may inherit a runtime with deferred ERP initialization. */
export function isAsyncChatAdmission(request:FunctionHttpRequest):boolean {
  if(request.method!=="POST"||!/^\/api\/chat\/sessions\/[A-Za-z0-9_-]+\/messages$/.test(request.url))return false;
  try{
    const body=request.rawBody?.length?JSON.parse(request.rawBody.toString("utf8")):request.body;
    return body!==null&&typeof body==="object"&&!Array.isArray(body)&&body.delivery==="async-chat"&&
      Object.keys(body).every(key=>["content","message","model","mode","workflowContext","nodeContext","documentContext","attachmentTicket","requestRevision","delivery","idempotencyKey"].includes(key));
  }catch{return false;}
}

/** Native Functions middleware has already parsed its request. Forward the
 * original raw bytes/URL to existing Fastify authentication and validation;
 * don't serialize parsed JSON or forward transport-specific hop headers. */
export async function handleFunctionHttp(input: FunctionComposition, request: FunctionHttpRequest): Promise<FunctionHttpResponse> {
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)) return response(405, "HTTP method is unsupported", "METHOD_NOT_ALLOWED");
  if (!request.url.startsWith("/") || request.url.startsWith("//")) return response(400, "Invalid API URL", "INVALID_API_URL");
  if (request.headers.upgrade || request.url.split("?", 1)[0]?.startsWith("/ws"))
    return response(426, "WebSocket streaming is not qualified for this Functions host. Use authenticated event polling.", "FUNCTIONS_STREAMING_UNAVAILABLE");
  let payload: Buffer | undefined;
  if (request.rawBody !== undefined) payload = request.rawBody;
  else if (request.body !== undefined) {
    // The native framework initializes body={} even for bodyless GETs. This
    // is not permission to reconstruct a parsed JSON payload or lose bytes.
    const emptyMiddlewareBody = ["GET", "HEAD", "DELETE", "OPTIONS"].includes(request.method) && request.body !== null &&
      typeof request.body === "object" && !Array.isArray(request.body) && Object.keys(request.body).length === 0 &&
      (!request.headers["content-length"] || request.headers["content-length"] === "0") && !request.headers["transfer-encoding"];
    if (!emptyMiddlewareBody) return response(400, "Original request bytes are required for this Functions adapter", "FUNCTIONS_RAW_BODY_REQUIRED");
  }
  if (payload && payload.length > 10 * 1024 * 1024) return response(413, "Request body exceeds 10 MB", "BODY_LIMIT");
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase())));
  let invocationEntered = false;
  try {
    // OPTIONS is transport negotiation, never a database/model/ERP operation.
    // Do not make the browser acquire a writer just to learn CORS headers.
    if (request.method === "OPTIONS") {
      const result = await handleFunctionPreflight(input.config, { ...request, headers });
      return { ...result, headers: Object.fromEntries(Object.entries(result.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase()))) };
    }
    // Safe committed reads must not take an exclusive writer lease merely to
    // restore an account or open a list. Mutation/control routes stay below.
    if (isFunctionProgressRequest(input.config, request)) {
      try {
        const result = await handleFunctionProgress(input.config, request, undefined, {chatTaskAdmissionAvailable:Boolean(input.chatTransport)});
        return { ...result, headers: Object.fromEntries(Object.entries(result.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase()))) };
      } catch (error) {
        if (!(error instanceof FunctionServiceReadRequired)) throw error;
        // The snapshot reader has closed. Exact protected-review services are
        // opened below with their original ownership and authorization rules.
      }
    }
    if (isFunctionControlPlaneRequest(input.config, request)) {
      const result = await handleFunctionControlPlane({ ...input, signal: request.signal }, { ...request, headers }, () => { invocationEntered = true; });
      return { ...result, headers: Object.fromEntries(Object.entries(result.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase()))) };
    }
    if (isFunctionChatCancellationRequest(input.config, request)) {
      const result = await handleFunctionChatCancellation(input.config, { ...request, headers }, undefined, () => { invocationEntered = true; });
      return { ...result, headers: Object.fromEntries(Object.entries(result.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase()))) };
    }
    if (isFunctionChatCreationRequest(input.config, request)) {
      const result = await handleFunctionChatCreation({ ...input, signal: request.signal }, { ...request, headers }, () => { invocationEntered = true; });
      return { ...result, headers: Object.fromEntries(Object.entries(result.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase()))) };
    }
    const documentServiceRequest = /^\/api\/(?:pipeline(?:\/|$)|chat\/sessions\/[^/?]+\/attachments(?:\/|\?|$)|settings\/rag-policy(?:\/|\?|$))/.test(request.url);
    const authenticationOnly = request.method === "POST" && /^\/api\/auth\/(?:login|logout|register|refresh)$/.test(request.url);
    return await withFunctionRuntime({ ...input, signal: request.signal, ...(isAsyncChatAdmission(request)?{runtimePurpose:"chat-admission" as const}: documentServiceRequest ? { runtimePurpose: "document-services" as const } : authenticationOnly ? { runtimePurpose: "authentication" as const } : {}) }, async ({ app, services }) => {
      invocationEntered = true;
      const result = await app.inject({ method: request.method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS", url: request.url, headers,
        ...(payload?.length ? { payload } : {}), ...(request.ip ? { remoteAddress: request.ip } : {}) });
      // An API route may have converted a lost storage acknowledgement into a
      // generic 500. Preserve the original key's recovery guidance rather than
      // let a browser mistake that response for proof that nothing was saved.
      if (result.statusCode >= 500) services.repository.assertAuthority();
      return { statusCode: result.statusCode, headers: Object.fromEntries(Object.entries(result.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase()))), body: result.rawPayload };
    });
  } catch (error) {
    const authority = error instanceof FirestoreOwnershipFailure ? error : error instanceof Error && error.cause instanceof FirestoreOwnershipFailure ? error.cause : null;
    // Server-side bounded category only. Never log request bodies, actor/token,
    // storage records, raw SDK errors, URLs, lease IDs or provider credentials.
    console.warn(JSON.stringify({ severity: "WARNING", message: "Functions invocation unconfirmed",
      phase: invocationEntered ? "invocation-or-cleanup" : "initialization", authorityReason: authority?.reason ?? "UNCONFIRMED" }));
    const unavailable = response(503, "Invocation or cleanup could not be confirmed. Inspect the original request/run and reuse its original idempotency key; do not create a replacement run.", "FUNCTIONS_INVOCATION_UNCONFIRMED");
    // Keep the actionable receipt guidance visible to the configured web app.
    // Otherwise browsers hide this response behind a generic network error.
    const origin = request.headers.origin;
    if (typeof origin === "string" && input.config.corsOrigins.includes(origin)) Object.assign(unavailable.headers, {
      "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin",
    });
    return unavailable;
  }
}
