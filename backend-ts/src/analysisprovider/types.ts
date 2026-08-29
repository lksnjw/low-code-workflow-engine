export type AnalysisResponse = {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  measured: boolean;
};

export type ProviderInvocationContext = {
  promptTemplateVersion: string;
  fallbackUsed?: boolean;
  traceId?: string;
  sessionId?: string;
  messageId?: string;
  candidateId?: string;
  workflowId?: string;
  executionId?: string;
  actor?: { id: string; role: string };
};

export interface AnalysisProvider {
  generate(prompt: string, model: string, signal?: AbortSignal, context?: ProviderInvocationContext): Promise<AnalysisResponse>;
}
