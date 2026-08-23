import { createHash } from "node:crypto";

export function canonicalJSONBytes(value: unknown): Buffer {
  return Buffer.from(escapeGoJSON(JSON.stringify(sortValue(value))), "utf8");
}

export function resolvedParameterHash(value: Record<string, unknown>): string {
  return resolvedParameterHashBytes(canonicalJSONBytes(value));
}

export function resolvedParameterHashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
}

function escapeGoJSON(value: string): string {
  return value
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
