import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AnalysisResponse } from "../analysisprovider/types.js";
import { systemInstructionsFor } from "../prompts/contracts.js";
import { piBridgeAssistantMessage, piBridgeModel } from "./pi-provider-bridge.js";

/** Pi owns the authoring turn and cancellation. The model chooses the program
 * from the complete permitted catalog in prompt; no ERP dispatcher is exposed
 * while drafting. The existing provider boundary owns egress, validation,
 * retries/fallback eligibility and durable inference receipts. */
export async function runWorkflowAuthoringAgent(input: { prompt: string; version: string; signal?: AbortSignal },
  invoke: (signal: AbortSignal) => Promise<AnalysisResponse>): Promise<AnalysisResponse> {
  if (!/^prompt\/(?:candidate|workflow-modifier)\/v\d+$/.test(input.version)) throw new Error("Unsupported workflow authoring contract");
  input.signal?.throwIfAborted();
  const model = piBridgeModel("workflow-authoring", "Workflow authoring", 8192);
  let entered = false, response: AnalysisResponse | undefined, failure: unknown;
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (entered) throw new Error("The original workflow authoring turn has already been dispatched");
        entered = true;
        const signals = [input.signal, options?.signal].filter((value): value is AbortSignal => !!value);
        const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
        signal.throwIfAborted(); response = await invoke(signal); signal.throwIfAborted();
        if (!response.text.trim()) throw new Error("Workflow authoring returned no draft");
        stream.push({ type: "done", reason: "stop", message: piBridgeAssistantMessage(model,
          [{ type: "text", text: response.text }], "stop", 0, { input: response.inputTokens, output: response.outputTokens }, response.model, response.provider) });
      } catch (error) {
        failure = error;
        stream.push({ type: "error", reason: "error", error: { ...piBridgeAssistantMessage(model, [], "error", 0, { input: 0, output: 0 }),
          errorMessage: "Workflow authoring did not complete; no ERP action was dispatched" } });
      }
    })();
    return stream;
  };
  const agent = new Agent({ initialState: { model, tools: [], systemPrompt: systemInstructionsFor(input.version) }, streamFn,
    toolExecution: "sequential", finishTurn: async () => ({ action: "end" }) });
  const abort = () => agent.abort(); input.signal?.addEventListener("abort", abort, { once: true });
  try { await agent.prompt({ role: "user", content: input.prompt, timestamp: Date.now() }); }
  finally { input.signal?.removeEventListener("abort", abort); }
  input.signal?.throwIfAborted();
  if (failure) throw failure;
  if (!response || agent.state.messages.at(-1)?.role !== "assistant") throw new Error("Workflow authoring completion was not confirmed");
  return response;
}
