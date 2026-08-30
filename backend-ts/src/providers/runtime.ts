import { createHash, randomBytes } from "node:crypto";
import type { AnalysisProvider, AnalysisResponse, ProviderInvocationContext } from "../analysisprovider/types.js";
import type { Repository, StoredRecord } from "../repository/store.js";
import type { Executor } from "../runner/executor.js";
import { isGenerationFallbackEligible, OpenAICompatibleClient, OpenAICompatibleError } from "./openai-compatible.js";
import type { QueryMessage, QueryOptions, QueryToolDefinition, QueryTurnResult } from "../analysisprovider/query-types.js";

export const ANALYSIS_PROMPT_VERSION = "prompt/analysis/v1";
export const CANDIDATE_PROMPT_VERSION = "prompt/candidate/v1";

export type RuntimeProviderConfiguration = {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  apiKey: string;
  model: string;
  fallbackModel?: string;
  temperature: number;
  timeoutMs: number;
};

export class ProviderRuntime {
  #provider: ProvenanceAnalysisProvider | null = null;
  #rawClient: OpenAICompatibleClient | null = null;
  #configuration: RuntimeProviderConfiguration | null = null;

  constructor(readonly repository: Repository, readonly executor: Executor, readonly fetchImplementation?: typeof fetch) {}

  get configured(): boolean { return this.#provider !== null; }
  get configuration(): RuntimeProviderConfiguration | null { return this.#configuration === null ? null : { ...this.#configuration }; }

  activate(configuration: RuntimeProviderConfiguration): void {
    validateRuntimeProviderConfiguration(configuration);
    const rawClient = new OpenAICompatibleClient({ baseURL: configuration.baseURL, apiKey: configuration.apiKey, model: configuration.model, temperature: configuration.temperature, timeoutMs: configuration.timeoutMs, ...(this.fetchImplementation === undefined ? {} : { fetchImplementation: this.fetchImplementation }) });
    const provider = new ProvenanceAnalysisProvider(rawClient, this.repository, configuration);
    this.#rawClient = rawClient;
    this.#provider = provider;
    this.#configuration = { ...configuration };
    this.executor.setAnalysisProvider(provider, configuration.model);
  }

  async activateStoredOrStatic(staticConfiguration: RuntimeProviderConfiguration | null): Promise<void> {
    const stored = await this.repository.read((state) => Object.values(state.providers).find((item) => item.active === true) ?? null);
    if (stored !== null) this.activate(providerConfigurationFromRecord(stored));
    else if (staticConfiguration !== null) this.activate(staticConfiguration);
  }

  async generate(prompt: string, promptTemplateVersion: string, signal?: AbortSignal, model = ""): Promise<AnalysisResponse> {
    if (this.#provider === null) throw new Error("LLM provider is not configured");
    return this.#provider.generate(prompt, model, signal, { promptTemplateVersion });
  }

  async generateCandidate(prompt: string, promptTemplateVersion: string, validateResponse: (response: AnalysisResponse) => void, signal?: AbortSignal, provenance: Omit<ProviderInvocationContext, "promptTemplateVersion" | "fallbackUsed"> = {}): Promise<AnalysisResponse> {
    if (this.#provider === null || this.#configuration === null) throw new Error("LLM provider is not configured");
    const models = [this.#configuration.model, this.#configuration.fallbackModel ?? ""].filter((value, index, all) => value.trim() !== "" && all.indexOf(value) === index);
    let lastError: unknown = new Error("generation did not run");
    for (const [index, model] of models.entries()) {
      try {
        return await this.#provider.generateValidated(prompt, model, signal, { promptTemplateVersion, fallbackUsed: index > 0, ...provenance }, validateResponse);
      } catch (error) {
        lastError = error;
        if (index === 0 && models.length > 1 && isGenerationFallbackEligible(error)) continue;
        throw new Error(`Generation attempt failed for model ${JSON.stringify(model)}: ${errorText(error)}`);
      }
    }
    throw new Error(`All generation attempts failed: ${errorText(lastError)}`);
  }

  async queryWithTools(messages: QueryMessage[], tools: QueryToolDefinition[], options: QueryOptions): Promise<QueryTurnResult> {
    if (this.#rawClient === null) throw new Error("LLM provider is not configured");
    return this.#rawClient.queryWithTools(messages, tools, options);
  }

  async test(configuration: RuntimeProviderConfiguration, signal?: AbortSignal): Promise<AnalysisResponse> {
    validateRuntimeProviderConfiguration(configuration);
    const provider = new ProvenanceAnalysisProvider(createProviderClient(configuration, this.fetchImplementation), this.repository, configuration);
    return provider.generate("Reply with exactly OK.", configuration.model, signal, { promptTemplateVersion: "prompt/provider-test/v1" });
  }
}

export class ProvenanceAnalysisProvider implements AnalysisProvider {
  constructor(readonly inner: AnalysisProvider, readonly repository: Repository, readonly configuration: RuntimeProviderConfiguration) {}

  async generate(prompt: string, model: string, signal?: AbortSignal, context?: ProviderInvocationContext): Promise<AnalysisResponse> {
    return this.generateValidated(prompt, model, signal, context, () => undefined);
  }

  async generateValidated(prompt: string, model: string, signal: AbortSignal | undefined, context: ProviderInvocationContext | undefined, validateResponse: (response: AnalysisResponse) => void): Promise<AnalysisResponse> {
    const started = performance.now();
    const selectedModel = model.trim() === "" ? this.configuration.model : model;
    const promptTemplateVersion = context?.promptTemplateVersion ?? ANALYSIS_PROMPT_VERSION;
    try {
      const response = await this.inner.generate(prompt, selectedModel, signal, context);
      try { validateResponse(response); }
      catch (error) { throw error instanceof OpenAICompatibleError ? error : new OpenAICompatibleError(`Generated response was malformed: ${errorText(error)}`, "malformed"); }
      await this.record(prompt, promptTemplateVersion, response.provider, response.model, response.inputTokens, response.outputTokens, response.measured, elapsed(started), context?.fallbackUsed === true, "SUCCEEDED", context);
      return response;
    } catch (error) {
      await this.record(prompt, promptTemplateVersion, this.configuration.type, selectedModel, 0, 0, false, elapsed(started), context?.fallbackUsed === true, "FAILED", context);
      throw error;
    }
  }

  private async record(prompt: string, promptTemplateVersion: string, provider: string, model: string, inputTokens: number, outputTokens: number, measured: boolean, latencyMs: number, fallbackUsed: boolean, status: "SUCCEEDED" | "FAILED", context?: ProviderInvocationContext): Promise<void> {
    await this.repository.mutate((state) => {
      const id = `inv_${randomBytes(8).toString("hex")}`;
      state.invocationProvenance[id] = {
        id,
        promptTemplateVersion,
        promptSha256: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
        provider,
        model,
        inputTokens,
        outputTokens,
        measured,
        latencyMs,
        temperature: this.configuration.temperature,
        fallbackUsed,
        status,
        createdAt: new Date().toISOString(),
        ...(context?.traceId === undefined ? {} : { traceId: context.traceId }),
        ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...(context?.messageId === undefined ? {} : { messageId: context.messageId }),
        ...(context?.candidateId === undefined ? {} : { candidateId: context.candidateId }),
        ...(context?.workflowId === undefined ? {} : { workflowId: context.workflowId }),
        ...(context?.executionId === undefined ? {} : { executionId: context.executionId }),
        ...(context?.actor === undefined ? {} : { actor: context.actor }),
      };
    });
  }
}

export function providerConfigurationFromRecord(record: StoredRecord, timeoutMs = 60_000): RuntimeProviderConfiguration {
  return {
    id: stringValue(record.id),
    name: stringValue(record.name),
    type: stringValue(record.type),
    baseURL: stringValue(record.baseUrl),
    apiKey: stringValue(record.apiKey),
    model: stringValue(record.model),
    fallbackModel: stringValue(record.fallbackModel),
    temperature: finiteNumber(record.temperature, 0),
    timeoutMs,
  };
}

export function validateRuntimeProviderConfiguration(configuration: RuntimeProviderConfiguration): void {
  if (configuration.type !== "openai_compatible") throw new Error(`Unsupported configured provider type ${JSON.stringify(configuration.type)}`);
  if (configuration.baseURL.trim() === "") throw new Error("OpenAI-compatible base URL is required");
  if (configuration.apiKey.trim() === "") throw new Error("OpenAI-compatible API key is required");
  if (configuration.model.trim() === "") throw new Error("OpenAI-compatible model is required");
  if (configuration.model.includes(":latest") || (configuration.fallbackModel ?? "").includes(":latest")) throw new Error("OpenAI-compatible model IDs must be pinned and cannot use :latest");
  if (!Number.isFinite(configuration.temperature)) throw new Error("OpenAI-compatible temperature must be finite");
  if (!Number.isInteger(configuration.timeoutMs) || configuration.timeoutMs <= 0) throw new Error("OpenAI-compatible timeout must be a positive integer");
}

function createProviderClient(configuration: RuntimeProviderConfiguration, fetchImplementation?: typeof fetch): AnalysisProvider {
  return new OpenAICompatibleClient({ baseURL: configuration.baseURL, apiKey: configuration.apiKey, model: configuration.model, temperature: configuration.temperature, timeoutMs: configuration.timeoutMs, ...(fetchImplementation === undefined ? {} : { fetchImplementation }) });
}

function elapsed(started: number): number { return Math.max(0, Math.round((performance.now() - started) * 1000) / 1000); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function finiteNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
