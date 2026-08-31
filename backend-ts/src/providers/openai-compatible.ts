import type { AnalysisProvider, AnalysisResponse, ProviderInvocationContext } from "../analysisprovider/types.js";
import type { QueryMessage, QueryOptions, QueryToolCall, QueryToolDefinition, QueryTurnResult } from "../analysisprovider/query-types.js";

export type OpenAICompatibleOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

type OpenAIChatResponse = {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

type OpenAIQueryResponse = {
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
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
  constructor(message: string, readonly kind: OpenAICompatibleFailureKind, readonly statusCode: number | null = null) { super(message); this.name = "OpenAICompatibleError"; }
}

/*******************************************************************************
 * Function: isGenerationFallbackEligible
 *
 * Checks whether a provider failure permits trying the fallback model.
 ******************************************************************************/
export function isGenerationFallbackEligible(error: unknown): boolean {
  // "client" (HTTP 4xx) is included so a model-specific 400 (e.g. context-too-long or unsupported params)
  // triggers the fallback model rather than failing the whole request immediately.
  return error instanceof OpenAICompatibleError && ["timeout", "rate_limit", "server", "malformed", "client"].includes(error.kind);
}

export class OpenAICompatibleClient implements AnalysisProvider {
  readonly provider = "openai_compatible";
  readonly baseURL: string;
  readonly model: string;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

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
  async generate(prompt: string, model: string, signal?: AbortSignal, _context?: ProviderInvocationContext): Promise<AnalysisResponse> {
    const selectedModel = model.trim() === "" ? this.model : model;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({ model: selectedModel, messages: [{ role: "user", content: prompt }], temperature: this.temperature }),
        signal: combinedSignal,
      });
    } catch {
      if (signal?.aborted === true) throw new OpenAICompatibleError("OpenAI-compatible request was cancelled", "cancelled");
      if (timeoutSignal.aborted) throw new OpenAICompatibleError("OpenAI-compatible request timed out", "timeout");
      throw new OpenAICompatibleError("OpenAI-compatible request failed", "transport");
    }
    if (!response.ok) {
      const kind: OpenAICompatibleFailureKind = response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "client";
      throw new OpenAICompatibleError(`OpenAI-compatible provider returned HTTP ${response.status}`, kind, response.status);
    }
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch { throw new OpenAICompatibleError("OpenAI-compatible response was not valid JSON", "malformed"); }
    let parsed: OpenAIChatResponse;
    try { parsed = parseResponse(decoded); }
    catch (error) { throw new OpenAICompatibleError(error instanceof Error ? error.message : "OpenAI-compatible response has an invalid shape", "malformed"); }
    const text = firstNonblankChoice(parsed);
    if (text === "") throw new OpenAICompatibleError("OpenAI-compatible response contained no candidate text", "malformed");
    const measured = parsed.usage !== undefined;
    return {
      text: stripMarkdownFence(text),
      provider: this.provider,
      model: selectedModel,
      inputTokens: measured ? parsed.usage!.prompt_tokens : 0,
      outputTokens: measured ? parsed.usage!.completion_tokens : 0,
      measured,
    };
  }

  /*******************************************************************************
   * Function: queryWithTools
   *
   * Requests a completion with tool definitions and tool-call messages.
   ******************************************************************************/
  async queryWithTools(messages: QueryMessage[], tools: QueryToolDefinition[], options: QueryOptions): Promise<QueryTurnResult> {
    const selectedModel = (options.model ?? "").trim() === "" ? this.model : options.model!.trim();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          temperature: this.temperature,
          ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
        }),
        signal: combinedSignal,
      });
    } catch {
      if (options.signal?.aborted === true) throw new OpenAICompatibleError("Query request was cancelled", "cancelled");
      if (timeoutSignal.aborted) throw new OpenAICompatibleError("Query request timed out", "timeout");
      throw new OpenAICompatibleError("Query request failed", "transport");
    }
    if (!response.ok) {
      const kind: OpenAICompatibleFailureKind = response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "client";
      throw new OpenAICompatibleError(`Query provider returned HTTP ${response.status}`, kind, response.status);
    }
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch { throw new OpenAICompatibleError("Query response was not valid JSON", "malformed"); }
    const parsed = parseQueryResponse(decoded);
    const choice = parsed.choices[0];
    if (choice === undefined) throw new OpenAICompatibleError("Query response had no choices", "malformed");
    const measured = parsed.usage !== undefined;
    const inputTokens = measured ? parsed.usage!.prompt_tokens : 0;
    const outputTokens = measured ? parsed.usage!.completion_tokens : 0;
    const stopReason = choice.finish_reason ?? "stop";
    const text = (choice.message.content ?? "").trim();
    const toolCalls: QueryToolCall[] = [];
    if (Array.isArray(choice.message.tool_calls)) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type !== "function" || typeof tc.function?.name !== "string") continue;
        let args: Record<string, unknown> = {};
        try {
          const parsed_args = JSON.parse(tc.function.arguments);
          if (isRecord(parsed_args)) args = parsed_args;
        } catch { /* use empty args on parse failure */ }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
      }
    }
    return { text, toolCalls, stopReason, inputTokens, outputTokens };
  }
}

/*******************************************************************************
 * Function: parseQueryResponse
 *
 * Validates and normalizes a provider response containing tool calls.
 ******************************************************************************/
function parseQueryResponse(value: unknown): OpenAIQueryResponse {
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new Error("Query response has an invalid shape");
  const choices: OpenAIQueryResponse["choices"] = [];
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const content = choice.message.content === null ? null : typeof choice.message.content === "string" ? choice.message.content : null;
    const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls as OpenAIQueryResponse["choices"][0]["message"]["tool_calls"] : undefined;
    choices.push({ finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop", message: { content, ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}) } });
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
