import type { DispatchCapability } from "../validator/registry-validator.js";
import type { GovernedMCPClient } from "./mcp-client.js";
import type { ExecutableTool } from "./registry.js";

export class GenericMCPTool implements ExecutableTool {
  constructor(readonly name: string, readonly description: string, readonly client: GovernedMCPClient) {
    if (name.trim() === "" || client === null || client === undefined || typeof client.execute !== "function") throw new Error("generic MCP tool requires a name and governed client");
  }
  execute(capability: DispatchCapability, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.client.execute(this.name, capability, parameters, signal);
  }
}
