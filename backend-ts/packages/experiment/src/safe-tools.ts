const safeRegistrations = new WeakSet<object>();

export type ExperimentTool = Readonly<{ name: string; execute(parameters: Record<string, unknown>): Promise<Record<string, unknown>> }>;

export function createExperimentSpyTool(name: string, sink: (parameters: Record<string, unknown>) => void): ExperimentTool {
  const tool = Object.freeze({ name, async execute(parameters: Record<string, unknown>) { sink(structuredClone(parameters)); return { ok: true, would_execute: name }; } });
  safeRegistrations.add(tool);
  return tool;
}

export function requireExperimentSafeTools(tools: readonly ExperimentTool[]): void {
  for (const tool of tools) if (!safeRegistrations.has(tool)) throw new Error(`experiment gate-off refuses non-spy tool ${tool.name}`);
}
