import Fastify from "fastify";
import cors from "@fastify/cors";
import type { AppConfig } from "../config/config.js";
import type { FunctionHttpRequest, FunctionHttpResponse } from "./http.js";
import { initializeRequestTrace, requestTraceId } from "../trace/request-trace.js";

/** Browser transport negotiation only. Use the same CORS contract as the
 * application without opening a writer, MCP, model, queue or business route.
 * A successful preflight grants no application authority or execution.
 */
export async function handleFunctionPreflight(config: AppConfig, request: FunctionHttpRequest): Promise<FunctionHttpResponse> {
  if (request.method !== "OPTIONS") throw new Error("Only transport preflight is supported");
  const app = Fastify({ logger: false });
  try {
    await app.register(cors, { origin: config.corsOrigins, credentials: true,
      allowedHeaders: ["Origin", "Content-Type", "Accept", "Authorization"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] });
    app.addHook("onRequest", async request => { initializeRequestTrace(request); });
    app.addHook("onSend", async (request, reply, payload) => {
      reply.header("cache-control", "no-store"); reply.header("x-trace-id", requestTraceId(request)); return payload;
    });
    const result = await app.inject({ method: "OPTIONS", url: request.url, headers: request.headers });
    return { statusCode: result.statusCode, headers: result.headers, body: result.rawPayload };
  } finally { await app.close(); }
}
