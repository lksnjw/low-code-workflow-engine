export type QueryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type QueryToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type QueryOptions = {
  model?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type QueryToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type QueryTurnResult = {
  text: string;
  toolCalls: QueryToolCall[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
};
