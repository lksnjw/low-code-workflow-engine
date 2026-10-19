import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { piBridgeAssistantMessage, piBridgeModel } from "./pi-provider-bridge.js";

/** Pi schedules the exact registered invocation selected by the saved program.
 * The stream adapts a compiled command, not a new model plan. Authority, inputs,
 * receipts and credentials stay in the governed callback, outside transcripts.
 * Only explicitly authored agent nodes ask a model to choose further tools. */
export async function runWorkflowToolAgent<T>(input: {
  toolName: string;
  signal?: AbortSignal | undefined;
  onEvent?: (type: string) => void;
}, dispatch: (signal: AbortSignal) => Promise<T>): Promise<T> {
  input.signal?.throwIfAborted();
  if (!input.toolName.trim()) throw new Error("Workflow dispatch requires an exact registered tool name");
  const model = piBridgeModel("saved-workflow-dispatch", "Saved workflow dispatch", 128);
  let requested = false, entered = false, completed = false, failed = false;
  let result: T | undefined, failure: unknown;
  const tool: AgentTool = {
    name: input.toolName,
    label: input.toolName,
    description: "Execute this already validated saved-workflow invocation once through the governed ERP gateway.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    replay: "never",
    execute: async (_id, _parameters, toolSignal) => {
      if (entered) return { content: [{ type: "text", text: "Invocation already entered" }], details: { status: "BLOCKED" }, isError: true, terminate: true };
      entered = true;
      try {
        const signals = [input.signal, toolSignal].filter((value): value is AbortSignal => !!value);
        const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
        signal.throwIfAborted();
        result = await dispatch(signal);
        // Preserve the original receipt identity and observed acknowledgement,
        // including completion racing with cancellation. Never clone/replay it.
        completed = true;
        return { content: [{ type: "text", text: "Governed invocation completed" }], details: { status: "COMPLETED" } };
      } catch (error) {
        failed = true; failure = error;
        return { content: [{ type: "text", text: "Governed invocation failed or was blocked" }], details: { status: "FAILED" }, isError: true, terminate: true };
      }
    },
  };
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    if (requested) {
      stream.push({ type: "done", reason: "stop", message: piBridgeAssistantMessage(model, [{ type: "text", text: "Invocation finished" }], "stop", 1, { input: 0, output: 0 }) });
    } else {
      requested = true;
      stream.push({ type: "done", reason: "toolUse", message: piBridgeAssistantMessage(model,
        [{ type: "toolCall", id: "saved-invocation", name: input.toolName, arguments: {} }], "toolUse", 0, { input: 0, output: 0 }) });
    }
    return stream;
  };
  const agent = new Agent({ initialState: { model, tools: [tool], systemPrompt: "Execute only the supplied saved-workflow invocation. Never change arguments, select another tool or retry it." },
    streamFn, toolExecution: "sequential", finishTurn: async () => ({ action: "end" }) });
  const unsubscribe = input.onEvent ? agent.subscribe(event => { input.onEvent?.(event.type); }) : () => {};
  const abort = () => agent.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try { await agent.prompt({ role: "user", content: "Execute the registered invocation supplied by the saved workflow.", timestamp: Date.now() }); }
  finally { input.signal?.removeEventListener("abort", abort); unsubscribe(); }
  // Error identity is needed by the broker's private acknowledgement maps.
  if (failed) throw failure;
  if (!completed) {
    input.signal?.throwIfAborted();
    throw new Error("The workflow agent did not confirm the registered invocation");
  }
  return result as T;
}
