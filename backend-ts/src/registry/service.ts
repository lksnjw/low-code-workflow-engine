import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { AsyncMutex } from "../repository/async-mutex.js";
import { ruleArraySchema, toolArraySchema, type RuleDefinition, type ToolDefinition } from "./schemas.js";

export type RegistrySnapshot = Readonly<{
  tools: readonly ToolDefinition[];
  rules: readonly RuleDefinition[];
  versions: Readonly<{ tools: string; rules: string }>;
}>;

export class RegistryService {
  readonly #mutex = new AsyncMutex();
  #snapshot: RegistrySnapshot;
  #toolUpsertCallbacks = new Set<(tool: ToolDefinition) => void>();

  private constructor(readonly toolPath: string, readonly rulePath: string, snapshot: RegistrySnapshot) {
    this.#snapshot = snapshot;
  }

  static async load(toolPath: string, rulePath: string): Promise<RegistryService> {
    const [toolBytes, ruleBytes] = await Promise.all([readFile(toolPath), readFile(rulePath)]);
    const rawTools: unknown = JSON.parse(toolBytes.toString("utf8"));
    assertExplicitReadOnlyFlags(rawTools);
    const tools = toolArraySchema.parse(rawTools);
    const rules = ruleArraySchema.parse(JSON.parse(ruleBytes.toString("utf8")));
    return new RegistryService(toolPath, rulePath, freezeSnapshot(tools, rules, fileVersion(toolBytes), fileVersion(ruleBytes)));
  }

  snapshot(): RegistrySnapshot {
    return this.#snapshot;
  }

  hash(): string {
    const preimage = Buffer.concat([Buffer.from(this.#snapshot.versions.tools), Buffer.from([0]), Buffer.from(this.#snapshot.versions.rules)]);
    return `sha256:${createHash("sha256").update(preimage).digest("hex")}`;
  }

  findTool(name: string): ToolDefinition | undefined {
    const wanted = normalize(name);
    return this.#snapshot.tools.find((tool) => normalize(tool.name) === wanted || normalize(tool.tool_id) === wanted || normalize(tool.mcp_tool_name) === wanted);
  }

  readOnlyTools(): readonly ToolDefinition[] {
    return Object.freeze(
      this.#snapshot.tools.filter((tool) => tool.is_read_only === true),
    );
  }

  findRule(id: string): RuleDefinition | undefined {
    const wanted = normalize(id);
    return this.#snapshot.rules.find((rule) => normalize(rule.rule_id) === wanted);
  }

  enabledRules(): readonly RuleDefinition[] {
    return this.#snapshot.rules.filter((rule) => rule.enabled);
  }

  replaceRuleSnapshot(input: unknown, ruleVersion: string): void {
    const rules = ruleArraySchema.parse(input);
    if (ruleVersion.trim() === "") throw new Error("rule snapshot version is required");
    this.#snapshot = freezeSnapshot([...this.#snapshot.tools], rules, this.#snapshot.versions.tools, ruleVersion);
  }

  onToolUpsert(callback: (tool: ToolDefinition) => void): () => void {
    this.#toolUpsertCallbacks.add(callback);
    return () => this.#toolUpsertCallbacks.delete(callback);
  }

  async upsertTool(input: unknown, allowUpdate: boolean): Promise<ToolDefinition> {
    const tool = toolArraySchema.element.parse(input);
    return this.#mutex.runExclusive(async () => {
      const tools = [...this.#snapshot.tools];
      const index = tools.findIndex((item) => normalize(item.tool_id) === normalize(tool.tool_id) || normalize(item.name) === normalize(tool.name));
      if (index >= 0 && !allowUpdate) throw new Error(`tool ${tool.tool_id} already exists`);
      if (index >= 0) tools[index] = tool; else tools.push(tool);
      const raw = Buffer.from(JSON.stringify(tools, null, 2) + "\n", "utf8");
      await atomicReplace(this.toolPath, raw);
      this.#snapshot = freezeSnapshot(tools, [...this.#snapshot.rules], fileVersion(raw), this.#snapshot.versions.rules);
      for (const callback of this.#toolUpsertCallbacks) callback(structuredClone(tool));
      return structuredClone(tool);
    });
  }

  async upsertRule(input: unknown, allowUpdate: boolean): Promise<RuleDefinition> {
    const rule = ruleArraySchema.element.parse(input);
    return this.#mutex.runExclusive(async () => {
      const rules = [...this.#snapshot.rules];
      const index = rules.findIndex((item) => normalize(item.rule_id) === normalize(rule.rule_id));
      if (index >= 0 && !allowUpdate) throw new Error(`rule ${rule.rule_id} already exists`);
      if (index >= 0) rules[index] = rule; else rules.push(rule);
      const raw = Buffer.from(JSON.stringify(rules, null, 2) + "\n", "utf8");
      await atomicReplace(this.rulePath, raw);
      this.#snapshot = freezeSnapshot([...this.#snapshot.tools], rules, this.#snapshot.versions.tools, fileVersion(raw));
      return structuredClone(rule);
    });
  }

  async importTools(input: unknown, allowUpdates: boolean): Promise<{ tools: ToolDefinition[]; oldHash: string; newHash: string }> {
    const imported = toolArraySchema.parse(input);
    return this.#mutex.runExclusive(async () => {
      const oldHash = this.hash();
      const tools = [...this.#snapshot.tools];
      const seen = new Set<string>();
      for (const tool of imported) {
        const identity = normalize(tool.tool_id);
        if (seen.has(identity)) throw new Error(`duplicate tool ${tool.tool_id} in import`);
        seen.add(identity);
        const index = tools.findIndex((item) => normalize(item.tool_id) === identity || normalize(item.name) === normalize(tool.name));
        if (index >= 0 && !allowUpdates) throw new Error(`tool ${tool.tool_id} already exists`);
        if (index >= 0) tools[index] = tool; else tools.push(tool);
      }
      const raw = Buffer.from(JSON.stringify(tools, null, 2) + "\n", "utf8");
      await atomicReplace(this.toolPath, raw);
      this.#snapshot = freezeSnapshot(tools, [...this.#snapshot.rules], fileVersion(raw), this.#snapshot.versions.rules);
      for (const tool of imported) for (const callback of this.#toolUpsertCallbacks) callback(structuredClone(tool));
      return { tools: structuredClone(imported), oldHash, newHash: this.hash() };
    });
  }

  async importRules(input: unknown, allowUpdates: boolean): Promise<{ rules: RuleDefinition[]; oldHash: string; newHash: string }> {
    const imported = ruleArraySchema.parse(input);
    return this.#mutex.runExclusive(async () => {
      const oldHash = this.hash();
      const rules = [...this.#snapshot.rules];
      const seen = new Set<string>();
      for (const rule of imported) {
        const identity = normalize(rule.rule_id);
        if (seen.has(identity)) throw new Error(`duplicate rule ${rule.rule_id} in import`);
        seen.add(identity);
        const index = rules.findIndex((item) => normalize(item.rule_id) === identity);
        if (index >= 0 && !allowUpdates) throw new Error(`rule ${rule.rule_id} already exists`);
        if (index >= 0) rules[index] = rule; else rules.push(rule);
      }
      const raw = Buffer.from(JSON.stringify(rules, null, 2) + "\n", "utf8");
      await atomicReplace(this.rulePath, raw);
      this.#snapshot = freezeSnapshot([...this.#snapshot.tools], rules, this.#snapshot.versions.tools, fileVersion(raw));
      return { rules: structuredClone(imported), oldHash, newHash: this.hash() };
    });
  }
}

export async function ensureRuntimeRegistries(options: {
  toolPath: string;
  rulePath: string;
  frozenToolPath: string;
  frozenRulePath: string;
}): Promise<void> {
  await Promise.all([
    copyIfMissing(options.frozenToolPath, options.toolPath),
    copyIfMissing(options.frozenRulePath, options.rulePath),
  ]);
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function atomicReplace(path: string, raw: Uint8Array): Promise<void> {
  const temp = resolve(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  const backup = `${path}.bak`;
  try {
    await writeFile(temp, raw, { mode: 0o600, flag: "wx" });
    const handle = await open(temp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    try { await copyFile(path, backup); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(temp, path);
    await rm(backup, { force: true });
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function fileVersion(raw: Uint8Array): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

function freezeSnapshot(tools: ToolDefinition[], rules: RuleDefinition[], toolVersion: string, ruleVersion: string): RegistrySnapshot {
  return Object.freeze({
    tools: Object.freeze(structuredClone(tools).map((item) => Object.freeze(item))),
    rules: Object.freeze(structuredClone(rules).map((item) => Object.freeze(item))),
    versions: Object.freeze({ tools: toolVersion, rules: ruleVersion }),
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function assertExplicitReadOnlyFlags(input: unknown): void {
  if (!Array.isArray(input)) return;
  for (const [index, item] of input.entries()) {
    if (
      typeof item !== "object" ||
      item === null ||
      Object.hasOwn(item, "is_read_only")
    )
      continue;
    const record = item as Record<string, unknown>;
    const identity =
      typeof record.name === "string" && record.name.trim() !== ""
        ? record.name
        : typeof record.tool_id === "string" && record.tool_id.trim() !== ""
          ? record.tool_id
          : `at index ${index}`;
    throw new Error(
      `tool ${JSON.stringify(identity)} is missing required is_read_only`,
    );
  }
}
