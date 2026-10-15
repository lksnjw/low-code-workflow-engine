import type { ChatModelAttempt } from "../repository/store.js";
import type { AESGCMCodec } from "./aes-gcm.js";

/** Same bounded server-only receipt, without whole-result AES in native mode. */
export function storeChatModelContent(attempts: readonly ChatModelAttempt[], target: ChatModelAttempt, bytes: Buffer | undefined, native: boolean, codec: AESGCMCodec) {
  if (!bytes) return;
  const retained=attempts.reduce((sum,attempt)=>sum+(attempt.resultCiphertext?.length??(attempt.resultFields?Buffer.byteLength(JSON.stringify(attempt.resultFields)):0)),0);
  if(bytes.length>256_000 || retained+bytes.length*2>1_000_000)throw new Error("Bounded model receipt budget exceeded");
  if(native){target.resultFields=JSON.parse(bytes.toString("utf8")) as Record<string,unknown>;delete target.resultCiphertext;}
  else target.resultCiphertext=codec.encode(bytes).toString("base64");
}
