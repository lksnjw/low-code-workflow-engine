import type { DispatchCapability } from "../validator/registry-validator.js";

export type DispatchIdentity = Readonly<{
  userId: string;
  localRole: string;
  erpbridgeRole: string | null;
}>;

/*******************************************************************************
 * Function: createDispatchIdentity
 *
 * Builds an immutable user and role identity for tool dispatch.
 ******************************************************************************/
export function createDispatchIdentity(
  user: { id: string; role: string },
  roleMap: Readonly<Record<string, string>>,
): DispatchIdentity {
  const userId = user.id.trim();
  const localRole = user.role.trim();
  if (userId === "" || localRole === "")
    throw new Error("dispatch identity requires a user ID and local role");
  return Object.freeze({
    userId,
    localRole,
    erpbridgeRole: roleMap[localRole]?.trim() || null,
  });
}

export interface ExecutableTool {
  readonly name: string;
  readonly description: string;
  execute(
    capability: DispatchCapability,
    parameters: Record<string, unknown>,
    identity: DispatchIdentity,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ExecutableTool>();

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a ToolRegistry instance with its required state.
   ******************************************************************************/
  constructor(readonly fallback: ExecutableTool | null = null) {
    if (fallback !== null) assertExecutableTool(fallback);
  }

  /*******************************************************************************
   * Function: register
   *
   * Validates and registers an executable tool by name.
   ******************************************************************************/
  register(tool: ExecutableTool): void {
    assertExecutableTool(tool);
    this.#tools.set(tool.name, tool);
  }

  /*******************************************************************************
   * Function: has
   *
   * Reports whether the registry contains a matching executable tool.
   ******************************************************************************/
  has(name: string): boolean {
    return this.get(name) !== this.fallback || this.#tools.has(name);
  }
  /*******************************************************************************
   * Function: get
   *
   * Resolves a tool using supported name variations or the configured
   * fallback.
   ******************************************************************************/
  get(name: string): ExecutableTool | null {
    const exact = this.#tools.get(name);
    if (exact !== undefined) return exact;
    // Normalise hyphens↔underscores (send_email → send-email and vice-versa).
    const hyphenated = name.replace(/_/g, "-");
    const fromHyphen = this.#tools.get(hyphenated);
    if (fromHyphen !== undefined) return fromHyphen;
    const underscored = name.replace(/-/g, "_");
    const fromUnderscore = this.#tools.get(underscored);
    if (fromUnderscore !== undefined) return fromUnderscore;
    // Strip common LLM hallucination prefixes (dynamic_, static_, auto_)
    // and retry the full normalisation chain on the stripped name.
    const stripped = name.replace(/^(dynamic|static|auto)_/, "");
    if (stripped !== name) {
      const strippedExact = this.#tools.get(stripped);
      if (strippedExact !== undefined) return strippedExact;
      const strippedHyphen = this.#tools.get(stripped.replace(/_/g, "-"));
      if (strippedHyphen !== undefined) return strippedHyphen;
      const strippedUnderscore = this.#tools.get(stripped.replace(/-/g, "_"));
      if (strippedUnderscore !== undefined) return strippedUnderscore;
    }
    return this.fallback;
  }
  /*******************************************************************************
   * Function: names
   *
   * Returns registered tool names in sorted order.
   ******************************************************************************/
  names(): string[] {
    return [...this.#tools.keys()].sort();
  }
}

/*******************************************************************************
 * Function: assertExecutableTool
 *
 * Requires a tool to have a nonempty name and an execute function.
 ******************************************************************************/
function assertExecutableTool(
  tool: ExecutableTool | null | undefined,
): asserts tool is ExecutableTool {
  if (
    tool === null ||
    tool === undefined ||
    typeof tool.name !== "string" ||
    tool.name.trim() === "" ||
    typeof tool.execute !== "function"
  )
    throw new Error("tool must have a nonblank name and execute function");
}
