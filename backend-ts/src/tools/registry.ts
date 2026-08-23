import type { DispatchCapability } from "../validator/registry-validator.js";

export interface ExecutableTool {
  readonly name: string;
  readonly description: string;
  execute(capability: DispatchCapability, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ExecutableTool>();

  constructor(readonly fallback: ExecutableTool | null = null) {
    if (fallback !== null) assertExecutableTool(fallback);
  }

  register(tool: ExecutableTool): void {
    assertExecutableTool(tool);
    this.#tools.set(tool.name, tool);
  }

  has(name: string): boolean { return this.#tools.has(name); }
  get(name: string): ExecutableTool | null { return this.#tools.get(name) ?? this.fallback; }
  names(): string[] { return [...this.#tools.keys()].sort(); }
}

function assertExecutableTool(tool: ExecutableTool | null | undefined): asserts tool is ExecutableTool {
  if (tool === null || tool === undefined || typeof tool.name !== "string" || tool.name.trim() === "" || typeof tool.execute !== "function") throw new Error("tool must have a nonblank name and execute function");
}
