export type GenerationDiagnostics = {
  finishReason: "stop" | "length" | "content_filter" | "tool_calls" | "other";
  outputTokens?: number;
  reasoningTokens?: number;
};

export type AnalysisResponse = {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  measured: boolean;
  generationDiagnostics?: GenerationDiagnostics;
};

export type ProviderInvocationContext = {
  /** Private, bounded document input. Never persisted as invocation metadata. */
  documentAttachment?: { filename: string; mimeType: "image/png" | "image/jpeg" | "application/pdf"; dataBase64: string; sha256: string };
  promptTemplateVersion: string;
  fallbackUsed?: boolean;
  traceId?: string;
  sessionId?: string;
  messageId?: string;
  candidateId?: string;
  workflowId?: string;
  executionId?: string;
  actor?: { id: string; role: string };
  maxOutputTokens?: number;
  egress?: { purpose: "interactive" | "runtime_analysis" | "runtime_agent"; dataClass: "public" | "internal" | "confidential" | "restricted" };
};

export interface AnalysisProvider {
  generate(prompt: string, model: string, signal?: AbortSignal, context?: ProviderInvocationContext): Promise<AnalysisResponse>;
}
