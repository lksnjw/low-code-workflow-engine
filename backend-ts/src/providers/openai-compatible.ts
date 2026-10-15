import { createHash } from "node:crypto";
import { boundedJSONRequest, InvalidResponseJSON, type OwnedJSONRequest } from "../core/bounded-json-request.js";
import { OperationDeadlineExceeded } from "../core/bounded-operation.js";
import type { AnalysisProvider, AnalysisResponse, GenerationDiagnostics, ProviderInvocationContext } from "../analysisprovider/types.js";
import type { QueryMessage, QueryOptions, QueryToolCall, QueryToolDefinition, QueryTurnResult } from "../analysisprovider/query-types.js";
import { generationMessages } from "../prompts/contracts.js";
import { captureProviderContinuation, providerWireMessages } from "../analysisprovider/provider-continuation.js";

export type OpenAICompatibleOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
  ownRequest?: (request: OwnedJSONRequest) => void;
};

type OpenAIChatResponse = {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

type OpenAIQueryResponse = {
  choices: Array<{
    finish_reason: string;
    explicit_finish_reason_stop: boolean;
    message: {
      content: string | null;
      reasoning?: unknown;
      reasoning_content?: unknown;
      reasoning_details?: unknown;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

export type OpenAICompatibleFailureKind = "timeout" | "rate_limit" | "server" | "client" | "transport" | "malformed" | "cancelled";

export class OpenAICompatibleError extends Error {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a OpenAICompatibleError instance with its required state.
   ******************************************************************************/
  constructor(message: string, readonly kind: OpenAICompatibleFailureKind, readonly statusCode: number | null = null, readonly generationDiagnostics?: GenerationDiagnostics) { super(message); this.name = "OpenAICompatibleError"; }
}

/*******************************************************************************
 * Function: isGenerationFallbackEligible
 *
 * Checks whether a provider failure permits trying the fallback model.
 ******************************************************************************/
export function isGenerationFallbackEligible(error: unknown): boolean {
  // Authentication, authorization and malformed client requests are not
  // repaired by trying another model with the same credentials.
  return error instanceof OpenAICompatibleError && ["timeout", "rate_limit", "server", "malformed"].includes(error.kind);
}

export function isQueryFallbackEligible(error: unknown): boolean {
  // Invalid tool calls, credentials, policy denials and cancellation do not
  // become valid by asking a different model. Never retry an ERP operation here.
  return error instanceof OpenAICompatibleError && ["timeout", "rate_limit", "server", "transport"].includes(error.kind);
}

/** One pure wire builder for resident generation and exact phased dispatch. */
export function generationRequestBody(baseURL: string, model: string, temperature: number, prompt: string, context?: ProviderInvocationContext) {
  const attachment = context?.documentAttachment;
  if (attachment) {
    if (!["prompt/document-attachment/v1", "prompt/document-preview/v1"].includes(context.promptTemplateVersion ?? "") || context.egress?.purpose !== "interactive" || context.egress.dataClass !== "restricted" ||
        !["image/png", "image/jpeg", "application/pdf"].includes(attachment.mimeType) || attachment.filename.length > 120 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.dataBase64) || attachment.dataBase64.length > 5_592_408 ||
        Buffer.from(attachment.dataBase64, "base64").length > 4 * 1024 * 1024 ||
        createHash("sha256").update(Buffer.from(attachment.dataBase64, "base64")).digest("hex") !== attachment.sha256)
      throw new Error("Document model input must be bounded, source-bound and explicitly approved for interactive review");
    if (attachment.mimeType === "application/pdf" && baseURL.trim().replace(/\/+$/, "") !== "https://openrouter.ai/api/v1")
      throw new Error("Native PDF review is only configured for the reviewed OpenRouter adapter");
  }
  const messages = generationMessages(prompt, context?.promptTemplateVersion).map(message => !attachment || message.role !== "user" ? message : {
    role: message.role, content: [{ type: "text", text: message.content }, attachment.mimeType === "application/pdf"
      ? { type: "file", file: { filename: attachment.filename, file_data: `data:application/pdf;base64,${attachment.dataBase64}` } }
      : { type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` } }],
  });
  return { model, messages, temperature,
    ...(attachment?.mimeType === "application/pdf" ? { plugins: [{ id: "file-parser", pdf: { engine: "native" } }] } : {}),
    ...(context?.maxOutputTokens === undefined ? {} : { max_tokens: context.maxOutputTokens }),
    ...(interactiveGenerationReasoningProfile(baseURL, model, context) ? { reasoning: interactiveGenerationReasoningProfile(baseURL, model, context) === "openrouter-gemini-bounded-low/v1" ? { effort: "low" } : { enabled: false } } : {}),
    ...(interactiveGenerationReasoningProfile(baseURL, model, context) === "openrouter-gemini-bounded-low/v1" ? { response_format: { type: "json_object" } } : {}),
    ...(context?.promptTemplateVersion === "prompt/local-policy/v2" && baseURL.trim().replace(/\/+$/, "") === "https://openrouter.ai/api/v1" && model === "deepseek/deepseek-v4.1-flash"
      ? { response_format: { type: "json_object" }, reasoning: { enabled: false } } : {}) };
}

/** Explicit low-latency sampling for current interactive DeepSeek requests.
 * Runtime nodes, historical prompt contracts, other endpoints and models keep
 * their reviewed behavior. This changes inference, never ERP authority. */
export function interactiveQueryReasoningProfile(baseURL: string, model: string, options: QueryOptions) {
  // Gemini's published model contract requires thinking and accepts low, not
  // "none". Bound only the new small routing/chat contracts; never disable it
  // or change historical/runtime request semantics.
  if (baseURL.trim().replace(/\/+$/, "") === "https://openrouter.ai/api/v1" && model === "google/gemini-3.8-flash" &&
      options.context?.egress?.purpose === "interactive" && ["prompt/intent-routing/v3", "prompt/intent-routing/v4", "prompt/erp-chat/v3", "prompt/erp-chat/v4"].includes(options.promptTemplateVersion ?? ""))
    return "openrouter-gemini-bounded-low/v1" as const;
  return baseURL.trim().replace(/\/+$/, "") === "https://openrouter.ai/api/v1" && ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash"].includes(model) &&
    options.context?.egress?.purpose === "interactive" &&
    ["prompt/intent-routing/v1", "prompt/intent-routing/v2", "prompt/intent-routing/v3", "prompt/intent-routing/v4", "prompt/erp-chat/v1", "prompt/erp-chat/v2", "prompt/erp-chat/v3", "prompt/erp-chat/v4", "prompt/conversation/v1", "prompt/workflow-discussion/v1", "prompt/query/v6", "prompt/action/v5"].includes(options.promptTemplateVersion ?? "")
    ? model === "qwen/qwen3.8-flash" ? "openrouter-qwen-interactive-fast/v1" as const : "openrouter-deepseek-interactive-fast/v1" as const : undefined;
}
export function interactiveGenerationReasoningProfile(baseURL: string, model: string, context?: ProviderInvocationContext) {
  if (baseURL.trim().replace(/\/+$/, "") === "https://openrouter.ai/api/v1" && model === "google/gemini-3.8-flash" &&
      context?.egress?.purpose === "interactive" && ["prompt/local-policy/v2", "prompt/workflow-modifier/v3", "prompt/workflow-modifier/v4"].includes(context.promptTemplateVersion ?? ""))
    return "openrouter-gemini-bounded-low/v1" as const;
  return baseURL.trim().replace(/\/+$/, "") === "https://openrouter.ai/api/v1" && model === "qwen/qwen3.8-flash" &&
    context?.egress?.purpose === "interactive" && context.promptTemplateVersion === "prompt/candidate/v21"
    ? "openrouter-qwen-interactive-fast/v1" as const : undefined;
}

export class OpenAICompatibleClient implements AnalysisProvider {
  readonly provider = "openai_compatible";
  readonly baseURL: string;
  readonly model: string;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #ownRequest: ((request: OwnedJSONRequest) => void) | undefined;

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a OpenAICompatibleClient instance with its required state.
   ******************************************************************************/
  constructor(options: OpenAICompatibleOptions) {
    this.baseURL = options.baseURL.trim().replace(/\/+$/, "");
    this.#apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#ownRequest = options.ownRequest;
    if (this.baseURL === "") throw new Error("OpenAI-compatible base URL is required");
    if (this.#apiKey === "") throw new Error("OpenAI-compatible API key is required");
    if (this.model === "") throw new Error("OpenAI-compatible model is required");
    if (!Number.isFinite(this.temperature)) throw new Error("OpenAI-compatible temperature must be finite");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("OpenAI-compatible timeout must be a positive integer");
  }

  /*******************************************************************************
   * Function: generate
   *
   * Requests a text completion and validates the provider response.
   ******************************************************************************/
  async generate(prompt: string, model: string, signal?: AbortSignal, context?: ProviderInvocationContext): Promise<AnalysisResponse> {
    const selectedModel = model.trim() === "" ? this.model : model;
    const decoded = await this.requestJSON(generationRequestBody(this.baseURL, selectedModel, this.temperature, prompt, context), signal, "OpenAI-compatible");
    const generationDiagnostics = context?.promptTemplateVersion === "prompt/local-policy/v2" ? policyResponseDiagnostics(decoded) : undefined;
    let parsed: OpenAIChatResponse;
    try { parsed = parseResponse(decoded); }
    catch (error) { throw new OpenAICompatibleError(error instanceof Error ? error.message : "OpenAI-compatible response has an invalid shape", "malformed", null, generationDiagnostics); }
    const text = firstNonblankChoice(parsed);
    if (text === "") throw new OpenAICompatibleError("OpenAI-compatible response contained no candidate text", "malformed", null, generationDiagnostics);
    const measured = parsed.usage !== undefined;
    return {
      text: stripMarkdownFence(text),
      provider: this.provider,
      model: selectedModel,
      inputTokens: measured ? parsed.usage!.prompt_tokens : 0,
      outputTokens: measured ? parsed.usage!.completion_tokens : 0,
      measured,
      ...(generationDiagnostics ? { generationDiagnostics } : {}),
    };
  }

  /*******************************************************************************
   * Function: queryWithTools
   *
   * Requests a completion with tool definitions and tool-call messages.
   ******************************************************************************/
  async queryWithTools(messages: QueryMessage[], tools: QueryToolDefinition[], options: QueryOptions): Promise<QueryTurnResult> {
    if (["prompt/conversation/v1", "prompt/workflow-discussion/v1", "prompt/intent-routing/v1", "prompt/intent-routing/v2", "prompt/intent-routing/v3", "prompt/intent-routing/v4"].includes(options.promptTemplateVersion ?? "") && tools.length) throw new Error("Assistant conversation cannot offer tools");
    const selectedModel = (options.model ?? "").trim() === "" ? this.model : options.model!.trim();
    const decoded = await this.requestJSON({
      model: selectedModel, messages: providerWireMessages(messages, selectedModel, this.baseURL), tools: tools.length > 0 ? tools : undefined, temperature: this.temperature,
      ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
      ...(interactiveQueryReasoningProfile(this.baseURL, selectedModel, options) ? { reasoning: interactiveQueryReasoningProfile(this.baseURL, selectedModel, options) === "openrouter-gemini-bounded-low/v1" ? { effort: "low" } : { enabled: false } } : {}),
    }, options.signal, "Query");
    const parsed = parseQueryResponse(decoded);
    const choice = parsed.choices[0];
    if (choice === undefined) throw new OpenAICompatibleError("Query response had no choices", "malformed");
    const measured = parsed.usage !== undefined;
    const inputTokens = measured ? parsed.usage!.prompt_tokens : 0;
    const outputTokens = measured ? parsed.usage!.completion_tokens : 0;
    const stopReason = choice.finish_reason || "stop";
    const text = (choice.message.content ?? "").trim();
    const toolCalls: QueryToolCall[] = [];
    if (Array.isArray(choice.message.tool_calls)) {
      const ids = new Set<string>();
      for (const tc of choice.message.tool_calls) {
        if (!isRecord(tc) || tc.type !== "function" || typeof tc.id !== "string" || !tc.id.trim() || ids.has(tc.id) ||
            !isRecord(tc.function) || typeof tc.function.name !== "string" || !tc.function.name.trim() || typeof tc.function.arguments !== "string")
          throw new OpenAICompatibleError("Query provider returned a malformed tool call", "malformed");
        ids.add(tc.id);
        let args: Record<string, unknown>;
        try {
          const parsed_args = JSON.parse(tc.function.arguments);
          if (!isRecord(parsed_args)) throw new Error("Arguments must be an object");
          args = parsed_args;
        } catch { throw new OpenAICompatibleError("Query tool arguments must be a valid JSON object", "malformed"); }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
      }
    }
    let providerContinuationSecret;
    if (toolCalls.length) {
      try { providerContinuationSecret = captureProviderContinuation(choice.message, selectedModel, this.baseURL); }
      catch { throw new OpenAICompatibleError("Query provider returned invalid continuation metadata", "malformed"); }
    }
    // Interactive reads, tool-less conversation and semantic routing require
    // explicit completion. Runtime turns retain their persisted shape/ACKs.
    return { text, toolCalls, stopReason,
      ...(["prompt/query/v4", "prompt/query/v5", "prompt/query/v6", "prompt/workflow-discussion/v1", "prompt/conversation/v1", "prompt/intent-routing/v1", "prompt/intent-routing/v2", "prompt/intent-routing/v3", "prompt/intent-routing/v4", "prompt/erp-chat/v1", "prompt/erp-chat/v2", "prompt/erp-chat/v3", "prompt/erp-chat/v4"].includes(options.promptTemplateVersion ?? "") ? { completionConfirmed: choice.explicit_finish_reason_stop && toolCalls.length === 0 } : {}),
      inputTokens, outputTokens, measured, model: selectedModel, provider: this.provider,
      ...(providerContinuationSecret ? { providerContinuationSecret } : {}) };
  }
  private async requestJSON(payload: Record<string, unknown>, signal: AbortSignal | undefined, label: string): Promise<unknown> {
    try {
      const { response, decoded } = await boundedJSONRequest(this.#fetch, `${this.baseURL}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify(payload), ...(signal === undefined ? {} : { signal }),
      }, this.timeoutMs, `${label} provider response`, this.#ownRequest);
      if (!response.ok) {
        const kind: OpenAICompatibleFailureKind = response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "client";
        throw new OpenAICompatibleError(`${label} provider returned HTTP ${response.status}`, kind, response.status);
      }
      return decoded;
    } catch (error) {
      if (signal?.aborted) throw new OpenAICompatibleError(`${label} request was cancelled`, "cancelled");
      if (error instanceof OpenAICompatibleError) throw error;
      if (error instanceof OperationDeadlineExceeded) throw new OpenAICompatibleError(`${label} request timed out`, "timeout");
      if (error instanceof InvalidResponseJSON) throw new OpenAICompatibleError(`${label} response was not valid JSON`, "malformed");
      throw new OpenAICompatibleError(`${label} request failed`, "transport");
    }
  }

}

/** Finite policy-only metadata; never retain provider bodies or reasoning. */
function policyResponseDiagnostics(value: unknown): GenerationDiagnostics | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const choice = value.choices.find(item => isRecord(item) && isRecord(item.message) && typeof item.message.content === "string" && item.message.content.trim()) ?? value.choices[0];
  if (!isRecord(choice)) return undefined;
  const finishReason = ["stop", "length", "content_filter", "tool_calls"].includes(choice.finish_reason as string) ? choice.finish_reason as GenerationDiagnostics["finishReason"] : "other";
  const usage = isRecord(value.usage) ? value.usage : {};
  const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  return { finishReason, ...(nonnegativeInteger(usage.completion_tokens) ? { outputTokens: usage.completion_tokens } : {}),
    ...(nonnegativeInteger(details.reasoning_tokens) ? { reasoningTokens: details.reasoning_tokens } : {}) };
}

/*******************************************************************************
 * Function: parseQueryResponse
 *
 * Validates and normalizes a provider response containing tool calls.
 ******************************************************************************/
function parseQueryResponse(value: unknown): OpenAIQueryResponse {
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new OpenAICompatibleError("Query response has an invalid shape", "malformed");
  const choices: OpenAIQueryResponse["choices"] = [];
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const sourceMessage = choice.message;
    const content = choice.message.content === null ? null : typeof choice.message.content === "string" ? choice.message.content : null;
    if (choice.message.tool_calls !== undefined && !Array.isArray(choice.message.tool_calls))
      throw new OpenAICompatibleError("Query provider returned malformed tool calls", "malformed");
    const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls as OpenAIQueryResponse["choices"][0]["message"]["tool_calls"] : undefined;
    choices.push({ finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop", explicit_finish_reason_stop: choice.finish_reason === "stop", message: { content,
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
      ...Object.fromEntries(["reasoning", "reasoning_content", "reasoning_details"].filter(key => Object.hasOwn(sourceMessage, key)).map(key => [key, sourceMessage[key]])),
    } });
  }
  let usage: OpenAIQueryResponse["usage"];
  if (value.usage !== undefined && isRecord(value.usage) && nonnegativeInteger(value.usage.prompt_tokens) && nonnegativeInteger(value.usage.completion_tokens)) {
    usage = { prompt_tokens: value.usage.prompt_tokens, completion_tokens: value.usage.completion_tokens };
  }
  return { choices, ...(usage === undefined ? {} : { usage }) };
}

/*******************************************************************************
 * Function: parseResponse
 *
 * Validates and normalizes a provider text-completion response.
 ******************************************************************************/
function parseResponse(value: unknown): OpenAIChatResponse {
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new Error("OpenAI-compatible response has an invalid shape");
  const choices: OpenAIChatResponse["choices"] = [];
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") continue;
    choices.push({ message: { content: choice.message.content } });
  }
  let usage: OpenAIChatResponse["usage"];
  if (value.usage !== undefined) {
    if (!isRecord(value.usage) || !nonnegativeInteger(value.usage.prompt_tokens) || !nonnegativeInteger(value.usage.completion_tokens)) {
      throw new Error("OpenAI-compatible response has invalid token usage");
    }
    usage = { prompt_tokens: value.usage.prompt_tokens, completion_tokens: value.usage.completion_tokens };
  }
  return { choices, ...(usage === undefined ? {} : { usage }) };
}

/*******************************************************************************
 * Function: firstNonblankChoice
 *
 * Returns the first nonempty completion choice.
 ******************************************************************************/
function firstNonblankChoice(response: OpenAIChatResponse): string {
  for (const choice of response.choices) if (choice.message.content.trim() !== "") return choice.message.content.trim();
  return "";
}

/*******************************************************************************
 * Function: stripMarkdownFence
 *
 * Removes an enclosing Markdown code fence from text.
 ******************************************************************************/
function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:ya?ml)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/*******************************************************************************
 * Function: nonnegativeInteger
 *
 * Checks whether a value is a nonnegative integer.
 ******************************************************************************/
function nonnegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
/*******************************************************************************
 * Function: isRecord
 *
 * Checks whether a value is a non-null object other than an array.
 ******************************************************************************/
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
