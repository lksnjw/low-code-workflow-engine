import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const magic = Buffer.from("LCWE_STATE_V1", "ascii");

export class AESGCMCodec {
  readonly #key: Buffer;

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a AESGCMCodec instance with its required state.
   ******************************************************************************/
  constructor(encodedKey: string) {
    this.#key = decodeEncryptionKey(encodedKey);
  }

  /*******************************************************************************
   * Function: encode
   *
   * Encrypts a payload with AES-256-GCM and includes its nonce and tag.
   ******************************************************************************/
  encode(plaintext: Uint8Array, nonce = randomBytes(12)): Buffer {
    if (nonce.byteLength !== 12) throw new Error("AES-GCM nonce must contain exactly 12 bytes");
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(magic);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([magic, nonce, ciphertext, cipher.getAuthTag()]);
  }

  /*******************************************************************************
   * Function: decode
   *
   * Authenticates and decrypts an encoded AES-GCM storage payload.
   ******************************************************************************/
  decode(payload: Uint8Array): Buffer {
    const bytes = Buffer.from(payload);
    const minimum = magic.byteLength + 12 + 16;
    if (bytes.byteLength < minimum || !bytes.subarray(0, magic.byteLength).equals(magic)) {
      throw new Error("invalid encrypted storage payload");
    }
    const nonceStart = magic.byteLength;
    const nonceEnd = nonceStart + 12;
    const tagStart = bytes.byteLength - 16;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(nonceStart, nonceEnd));
      decipher.setAAD(magic);
      decipher.setAuthTag(bytes.subarray(tagStart));
      return Buffer.concat([decipher.update(bytes.subarray(nonceEnd, tagStart)), decipher.final()]);
    } catch {
      throw new Error("decrypt storage payload: key mismatch or data tampering detected");
    }
  }
}

/*******************************************************************************
 * Function: decodeEncryptionKey
 *
 * Decodes and validates a 32-byte storage encryption key.
 ******************************************************************************/
function decodeEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("STORAGE_ENCRYPTION_KEY is required");
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.byteLength === 32 && base64.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) return base64;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const literal = Buffer.from(trimmed, "utf8");
  if (literal.byteLength === 32) return literal;
  throw new Error("STORAGE_ENCRYPTION_KEY must contain exactly 32 bytes (base64, hex, or literal)");
}
