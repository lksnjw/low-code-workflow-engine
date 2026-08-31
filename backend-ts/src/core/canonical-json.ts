import { createHash } from "node:crypto";

/*******************************************************************************
 * Function: canonicalJSONBytes
 *
 * Serializes recursively sorted JSON using Go-compatible escaping.
 ******************************************************************************/
export function canonicalJSONBytes(value: unknown): Buffer {
  return Buffer.from(escapeGoJSON(JSON.stringify(sortValue(value))), "utf8");
}

/*******************************************************************************
 * Function: resolvedParameterHash
 *
 * Hashes the canonical JSON representation of resolved parameters.
 ******************************************************************************/
export function resolvedParameterHash(value: Record<string, unknown>): string {
  return resolvedParameterHashBytes(canonicalJSONBytes(value));
}

/*******************************************************************************
 * Function: resolvedParameterHashBytes
 *
 * Returns a prefixed SHA-256 hash of serialized parameter bytes.
 ******************************************************************************/
export function resolvedParameterHashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/*******************************************************************************
 * Function: sortValue
 *
 * Recursively sorts object keys while preserving array order.
 ******************************************************************************/
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
}

/*******************************************************************************
 * Function: escapeGoJSON
 *
 * Escapes characters to match Go JSON serialization.
 ******************************************************************************/
function escapeGoJSON(value: string): string {
  return value
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
