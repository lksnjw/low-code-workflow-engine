import { describe, expect, test, vi } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import {
  ProviderRuntime,
  ProvenanceAnalysisProvider,
  type RuntimeProviderConfiguration,
  validateRuntimeProviderConfiguration,
} from "../src/providers/runtime.js";
import { Repository } from "../src/repository/store.js";
import type { Executor } from "../src/runner/executor.js";

const configuration: RuntimeProviderConfiguration = {
  id: "provider_test",
  name: "Test provider",
  type: "openai_compatible",
  baseURL: "https://router.example/v1",
  apiKey: "test-key",
  model: "vendor/primary-2026-01-01",
  fallbackModel: "vendor/fallback-2025-12-01",
  temperature: 0,
  timeoutMs: 1_000,
};

describe("generation provider configuration", () => {
  test("startup rejects incomplete environment configuration and unpinned models", () => {
    expect(() =>
      loadConfig({
        GENERATION_BASE_URL: "https://router.example/v1",
        GENERATION_MODEL_PRIMARY: "vendor/model-2026-01-01",
      }),
    ).toThrow(/GENERATION_API_KEY/);

    expect(() =>
      loadConfig({
        GENERATION_BASE_URL: "https://router.example/v1",
        GENERATION_API_KEY: "secret",
      }),
    ).toThrow(/GENERATION_MODEL_PRIMARY/);

    expect(() =>
      loadConfig({
        GENERATION_BASE_URL: "https://router.example/v1",
        GENERATION_API_KEY: "secret",
        GENERATION_MODEL_PRIMARY: "vendor/model:latest",
      }),
    ).toThrow(/pinned/);

    expect(() => validateRuntimeProviderConfiguration({ ...configuration, apiKey: "" })).toThrow(/API key/);
    expect(() => validateRuntimeProviderConfiguration({ ...configuration, model: "" })).toThrow(/model/);
    expect(() =>
      validateRuntimeProviderConfiguration({ ...configuration, type: "unknown" as "openai_compatible" }),
    ).toThrow(/Unsupported/);
  });

  test("passes the configurable base URL and arbitrary pinned model and reads measured usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      providerResponse("name: measured", 17, 8),
    );
    const client = new OpenAICompatibleClient({ ...configuration, fetchImplementation: fetchImpl });

    const response = await client.generate("hello", configuration.model);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://router.example/v1/chat/completions");
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(request.model).toBe("vendor/primary-2026-01-01");
    expect(response).toEqual(expect.objectContaining({ inputTokens: 17, outputTokens: 8, measured: true }));
  });
});

describe("bounded generation fallback", () => {
  test("does not call the fallback when the primary succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(providerResponse("name: primary", 4, 3));
    const { runtime, repository } = providerRuntime(fetchImpl);

    const response = await runtime.generateCandidate("prompt", "candidate-v1", () => undefined);

    expect(response.model).toBe(configuration.model);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Object.values((await repository.snapshot()).invocationProvenance)).toEqual([
      expect.objectContaining({
        model: configuration.model,
        fallbackUsed: false,
        status: "SUCCEEDED",
        inputTokens: 4,
        outputTokens: 3,
        measured: true,
      }),
    ]);
  });

  test("falls back exactly once after a primary timeout and records both attempts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      )
      .mockResolvedValueOnce(providerResponse("name: fallback", 9, 5));
    const { runtime, repository } = providerRuntime(fetchImpl, { timeoutMs: 5 });

    const response = await runtime.generateCandidate("prompt", "candidate-v1", () => undefined);

    expect(response.model).toBe(configuration.fallbackModel);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const attempts = Object.values((await repository.snapshot()).invocationProvenance);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(
      expect.objectContaining({
        model: configuration.model,
        fallbackUsed: false,
        status: "FAILED",
        inputTokens: 0,
        outputTokens: 0,
        measured: false,
      }),
    );
    expect(attempts[1]).toEqual(
      expect.objectContaining({
        model: configuration.fallbackModel,
        fallbackUsed: true,
        status: "SUCCEEDED",
      }),
    );
  });

  test("does not fall back after a 4xx authentication failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "secret provider detail" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const { runtime, repository } = providerRuntime(fetchImpl);

    await expect(runtime.generateCandidate("prompt", "candidate-v1", () => undefined)).rejects.toThrow(
      /failed for model/,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Object.values((await repository.snapshot()).invocationProvenance)).toEqual([
      expect.objectContaining({ model: configuration.model, fallbackUsed: false, status: "FAILED" }),
    ]);
  });

  test("falls back when the primary produces a malformed candidate", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(providerResponse("not workflow yaml", 5, 2))
      .mockResolvedValueOnce(providerResponse("name: fallback", 6, 3));
    const { runtime, repository } = providerRuntime(fetchImpl);

    const response = await runtime.generateCandidate("prompt", "candidate-v1", (candidate) => {
      if (!candidate.text.includes(":")) {
        throw new Error("malformed workflow YAML");
      }
    });

    expect(response.model).toBe(configuration.fallbackModel);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Object.values((await repository.snapshot()).invocationProvenance)).toEqual([
      expect.objectContaining({ model: configuration.model, fallbackUsed: false, status: "FAILED" }),
      expect.objectContaining({ model: configuration.fallbackModel, fallbackUsed: true, status: "SUCCEEDED" }),
    ]);
  });

  test("stops after the fallback and returns a clear failure without reaching validation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const { runtime, repository } = providerRuntime(fetchImpl);
    const validate = vi.fn();

    await expect(runtime.generateCandidate("prompt", "candidate-v1", validate)).rejects.toThrow(
      /failed for model "vendor\/fallback-2025-12-01"/,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(validate).not.toHaveBeenCalled();
    expect(Object.values((await repository.snapshot()).invocationProvenance)).toEqual([
      expect.objectContaining({ model: configuration.model, fallbackUsed: false, status: "FAILED" }),
      expect.objectContaining({ model: configuration.fallbackModel, fallbackUsed: true, status: "FAILED" }),
    ]);
  });
});

describe("generation provenance integrity", () => {
  test("records unavailable usage as unmeasured zero rather than fabricated counts", async () => {
    const repository = new Repository(null);
    const provider = new ProvenanceAnalysisProvider(
      new OpenAICompatibleClient({
        ...configuration,
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(providerResponse("ok")),
      }),
      repository,
      configuration,
    );

    await provider.generate("sensitive prompt", configuration.model, undefined, {
      promptTemplateVersion: "candidate-v1",
      fallbackUsed: false,
    });

    const record = Object.values((await repository.snapshot()).invocationProvenance)[0];
    expect(record).toEqual(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        measured: false,
        fallbackUsed: false,
      }),
    );
  });

  test("records prompt version and SHA-256 without storing prompt text or API keys", async () => {
    const repository = new Repository(null);
    const provider = new ProvenanceAnalysisProvider(
      new OpenAICompatibleClient({
        ...configuration,
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(providerResponse("ok", 2, 1)),
      }),
      repository,
      configuration,
    );

    await provider.generate("sensitive prompt", configuration.model, undefined, {
      promptTemplateVersion: "candidate-v1",
      fallbackUsed: false,
    });

    const record = Object.values((await repository.snapshot()).invocationProvenance)[0];
    expect(record?.promptTemplateVersion).toBe("candidate-v1");
    expect(record?.promptSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record?.fallbackUsed).toBe(false);
    expect(JSON.stringify(record)).not.toContain("sensitive prompt");
    expect(JSON.stringify(record)).not.toContain(configuration.apiKey);
  });
});

test.skipIf(!liveEnvironmentConfigured())(
  "conditional live OpenRouter generation records real measured usage",
  async () => {
    const configuredFallback = process.env.GENERATION_MODEL_FALLBACK;
    const liveConfiguration: RuntimeProviderConfiguration = {
      id: "live_openrouter",
      name: "Live OpenRouter",
      type: "openai_compatible",
      baseURL: process.env.GENERATION_BASE_URL!,
      apiKey: process.env.GENERATION_API_KEY!,
      model: process.env.GENERATION_MODEL_PRIMARY!,
      ...(configuredFallback === undefined ? {} : { fallbackModel: configuredFallback }),
      temperature: Number(process.env.GENERATION_TEMPERATURE ?? "0"),
      timeoutMs: Number(process.env.GENERATION_TIMEOUT_MS ?? "30000"),
    };
    const repository = new Repository(null);
    const provider = new ProvenanceAnalysisProvider(
      new OpenAICompatibleClient(liveConfiguration),
      repository,
      liveConfiguration,
    );

    const response = await provider.generate("Reply with exactly: live-provider-ok", liveConfiguration.model, undefined, {
      promptTemplateVersion: "live-provider-smoke-v1",
      fallbackUsed: false,
    });

    expect(response.text.length).toBeGreaterThan(0);
    const record = Object.values((await repository.snapshot()).invocationProvenance)[0];
    expect(record?.measured).toBe(true);
    expect(record?.inputTokens).toBeGreaterThan(0);
    expect(record?.outputTokens).toBeGreaterThan(0);
  },
  60_000,
);

function providerRuntime(
  fetchImpl: typeof fetch,
  overrides: Partial<RuntimeProviderConfiguration> = {},
): { runtime: ProviderRuntime; repository: Repository } {
  const repository = new Repository(null);
  const executor = { setAnalysisProvider: vi.fn() } as unknown as Executor;
  const runtime = new ProviderRuntime(repository, executor, fetchImpl);
  runtime.activate({ ...configuration, ...overrides });
  return { runtime, repository };
}

function providerResponse(content: string, promptTokens?: number, completionTokens?: number): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      model: configuration.model,
      ...(promptTokens === undefined || completionTokens === undefined
        ? {}
        : { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function liveEnvironmentConfigured(): boolean {
  return Boolean(
    process.env.GENERATION_BASE_URL &&
      process.env.GENERATION_API_KEY &&
      process.env.GENERATION_MODEL_PRIMARY,
  );
}
