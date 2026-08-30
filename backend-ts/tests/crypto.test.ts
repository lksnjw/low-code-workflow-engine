import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import { canonicalJSONBytes, resolvedParameterHash } from "../src/core/canonical-json.js";
import { verifyPassword } from "../src/authn/password.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { RegistryService } from "../src/registry/service.js";

type Vector = { id: string; input: Record<string, unknown>; output: Record<string, unknown> };
const vectors = JSON.parse(await readFile("fixtures/parity/crypto/vectors.json", "utf8")) as Vector[];

describe("Go crypto parity vectors", () => {
  it("matches the deterministic AES-GCM envelope", () => {
    const vector = vectors.find((item) => item.id === "aes-256-gcm-fixed-nonce")!;
    const codec = new AESGCMCodec(String(vector.input.keyHex));
    const encoded = codec.encode(Buffer.from(String(vector.input.plaintextBase64), "base64"), Buffer.from(String(vector.input.nonceHex), "hex"));
    expect(encoded.toString("base64")).toBe(vector.output.envelopeBase64);
    expect(codec.decode(encoded).toString("base64")).toBe(vector.output.decodedBase64);
  });

  it("matches canonical resolved-parameter bytes and hash", () => {
    const vector = vectors.find((item) => item.id === "resolved-parameter-hash")!;
    expect(canonicalJSONBytes(vector.input).toString("utf8")).toBe(vector.output.canonicalUtf8);
    expect(resolvedParameterHash(vector.input)).toBe(vector.output.hash);
  });

  it("verifies the Go bcrypt cost-10 vector and rejects a wrong password", async () => {
    const vector = vectors.find((item) => item.id === "bcrypt-default-cost")!;
    expect(await verifyPassword(String(vector.output.hash), String(vector.input.password))).toBe(true);
    expect(await verifyPassword(String(vector.output.hash), "wrong-password")).toBe(false);
  });

  it("matches the fixed HS256 JWT byte-for-byte", () => {
    const vector = vectors.find((item) => item.id === "jwt-hs256-fixed-claims")!;
    const claims = vector.input.claims as Record<string, unknown>;
    const token = jwt.sign(claims, String(vector.input.secret), { algorithm: "HS256" });
    expect(token).toBe(vector.output.token);
    expect(jwt.verify(token, String(vector.input.secret), { algorithms: ["HS256"], ignoreExpiration: true })).toMatchObject(claims);
  });

  it("hashes workflow content as exact raw bytes", () => {
    const vector = vectors.find((item) => item.id === "workflow-content-hash")!;
    const raw = Buffer.from(String(vector.input.utf8Base64), "base64").toString("utf8");
    expect(workflowContentHash(raw)).toBe(vector.output.hash);
  });

  it("matches the frozen composite registry hash", async () => {
    const vector = vectors.find((item) => item.id === "registry-composite-hash")!;
    const registry = await RegistryService.load("fixtures/parity/http/runtime/all_tools_master_registry.json", "fixtures/parity/http/runtime/all_rules_master_registry.json");
    expect(registry.hash()).toBe(vector.output.hash);
    expect(`sha256:${createHash("sha256").update(await readFile("fixtures/parity/http/runtime/all_tools_master_registry.json")).digest("hex")}`).toBe(vector.input.toolFileSHA256);
    expect(`sha256:${createHash("sha256").update(await readFile("fixtures/parity/http/runtime/all_rules_master_registry.json")).digest("hex")}`).toBe(vector.input.ruleFileSHA256);
  });
});
