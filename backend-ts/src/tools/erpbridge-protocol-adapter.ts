import { Client, StreamableHTTPClientTransport, SdkHttpError } from "@modelcontextprotocol/client";
import type { ErpbridgeMcpSdkClient, ErpbridgeMcpSdkTool } from "./erpbridge-mcp-client.js";
import { boundedMcpFetch } from "./mcp-bounded-fetch.js";
import { superviseMcpNotifications } from "./mcp-notification-stream.js";
import { z } from "zod";

// Discovery is not admission. Preserve the original JSON Schema objects,
// including array-root output declarations, instead of the SDK's legacy
// object-only outputSchema projection. Unsupported schemas/remote contracts
// remain visible but cannot pass the engine's separate review/dispatch gate.
const schemaObject = z.record(z.string(), z.unknown());
const discoveryPage = z.object({
  tools: z.array(z.object({
    name: z.string().min(1).max(256).refine(name => name === name.trim(), "Tool name must be exact"),
    description: z.string().optional(),
    inputSchema: schemaObject.refine(schema => schema.type === "object", "Tool input schema must declare an object"),
    outputSchema: schemaObject.optional(),
    annotations: schemaObject.optional(),
    _meta: schemaObject.optional(),
  }).passthrough()).max(2048),
  nextCursor: z.string().min(1).max(4096).optional(),
}).passthrough();

/** Engine-owned adapter: preserve original discovery schemas and ToolPlane
 * metadata with the pinned SDK. Notification GET recovery only; no business replay, OAuth
 * step-up, sampling or elicitation. */
export function createBridgeProtocolAdapter(options: { baseURL: string; token: string; timeoutMs: number; fetch?: typeof fetch }): ErpbridgeMcpSdkClient {
  const root = new URL(options.baseURL);
  if (!/^https?:$/.test(root.protocol) || root.username || root.password || root.search || root.hash || !["", "/"].includes(root.pathname))
    throw new Error("ERPBridge base URL must be an HTTP(S) host root, not an MCP endpoint or credential-bearing URL");
  const client = new Client({ name: "workflow-engine", version: "1.0.0" }, {
    versionNegotiation: { mode: "legacy" }, // MCP 2025 initialize, not legacy SSE.
    inputRequired: { autoFulfill: false }, listMaxPages: 16,
  });
  const listeners = new Set<() => void>();
  let closed = false;
  const notifications = superviseMcpNotifications({ fetch: boundedMcpFetch(options.fetch ?? fetch, options.timeoutMs), endpoint: new URL("/mcp/", root).href, timeoutMs: options.timeoutMs,
    onGap: () => { for (const listener of listeners) listener(); },
    onFatal: () => { closed = true; void transport.close().catch(() => {}); void client.close().catch(() => {}); },
  });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp/", root), {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` }, redirect: "error" },
    fetch: notifications.fetch,
    onInsufficientScope: "throw", maxStepUpRetries: 0,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  client.setNotificationHandler("notifications/tools/list_changed", () => { for (const listener of listeners) listener(); });
  const requestOptions = { timeout: options.timeoutMs };
  return {
    metadataComplete: true,
    get available() { return !closed; },
    get notificationState() { return notifications.state; },
    connect: async () => { if (closed) throw new Error("ERPBridge MCP session is closed"); await client.connect(transport, requestOptions); if (closed) throw new Error("ERPBridge MCP session is unavailable"); },
    close: async () => { closed = true; notifications.close(); try { await transport.close(); } finally { try { await client.close(); } finally { listeners.clear(); } } },
    listTools: async () => {
      if (closed) throw new Error("ERPBridge MCP session is unavailable");
      // Own pagination: SDK aggregation silently returns a partial inventory
      // on repeated cursors/page exhaustion, which is not complete discovery.
      const tools: ErpbridgeMcpSdkTool[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 16; page++) {
        const result = await client.request({ method: "tools/list", ...(cursor ? { params: { cursor } } : {}) }, discoveryPage, requestOptions);
        tools.push(...structuredClone(result.tools) as ErpbridgeMcpSdkTool[]);
        if (tools.length > 2048 || Buffer.byteLength(JSON.stringify(tools)) > 2_000_000) throw new Error("ERPBridge discovery exceeds supported limits");
        if (result.nextCursor === undefined) return tools;
        if (!result.nextCursor || cursors.has(result.nextCursor)) throw new Error("ERPBridge discovery returned an invalid or repeated cursor");
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      throw new Error("ERPBridge discovery exceeds supported page limit");
    },
    // Supplying a descriptor prevents hidden cache/discovery RPCs and header
    // mismatch replay. The engine validates the actual reviewed output schema
    // and preserves failure envelopes before exposing any results.
    callTool: async (name, args, meta) => {
      if (closed) throw new Error("ERPBridge MCP session is unavailable");
      try { return await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, { ...requestOptions, toolDefinition: { name, inputSchema: { type: "object" } } }); }
      catch (error) {
        // SDK HTTP/protocol exceptions may embed the entire upstream body.
        // Never persist that body via agent error strings or run logs.
        if (error instanceof Error && ["AbortError", "OperationDeadlineExceeded"].includes(error.name)) throw error;
        if (error instanceof SdkHttpError && Number.isInteger(error.data?.status)) throw new Error(`ERPBridge MCP request failed (HTTP ${error.data.status}); the remote outcome is unconfirmed`);
        throw new Error("ERPBridge MCP reply was not confirmed; review the connection and saved evidence before retrying");
      }
    },
    onToolsChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
