import { createHmac } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ChatModelAttempt, RepositoryState } from "../repository/store.js";
import { AESGCMCodec, decodeEncryptionKey } from "./aes-gcm.js";

/** Explicit operator migration, never a side effect of reading a chat. Verify
 * every legacy request before applying any change; never resume/replay a job. */
export function migrateNativeChatContent(state: RepositoryState, encryptionKey: string) {
  if (Object.values(state.chatOperations).some(op => ["QUEUED", "RUNNING"].includes(op.status)))
    throw new Error("Active chat work blocks the content migration");
  const codec = new AESGCMCodec(encryptionKey), key = decodeEncryptionKey(encryptionKey);
  let readableModelReceipts=0;
  const changes: {id:string; revision?: Record<string,unknown>; removeInput:boolean; modelAttempts?:ChatModelAttempt[]}[]=[];
  for (const op of Object.values(state.chatOperations)) {
    if (op.revisionContextFields && op.revisionContextCiphertext) throw new Error("Ambiguous saved request context");
    let revision: Record<string,unknown> | undefined;
    if (op.revisionContextCiphertext) {
      const input: unknown = JSON.parse(codec.decode(Buffer.from(op.revisionContextCiphertext,"base64")).toString("utf8"));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid saved request context");
      revision = input as Record<string,unknown>;
      const body=revision.body, source=state.chats[op.sessionId]?.messages.find(message=>message.id===op.userMessageId);
      if (Object.keys(revision).sort().join("|")!=="body|content|operationId|userMessageId|version" || revision.version!==1 || revision.operationId!==op.id ||
          revision.userMessageId!==op.userMessageId || typeof revision.content!=="string" || !body || typeof body!=="object" || Array.isArray(body) ||
          createHmac("sha256",key).update(canonicalJSONBytes(body)).digest("hex")!==op.requestFingerprint ||
          source && (source.role!=="user" || source.text!==revision.content || source.operationId!==op.id)) throw new Error("Saved request identity does not match its original operation");
    }
    const removeInput=op.inputCiphertext!==undefined || op.inputFields!==undefined;
    let modelAttempts: ChatModelAttempt[] | undefined;
    if (op.modelAttemptsSecret && (op.contentStorageProfile!=="native-business-content/v1" || op.modelAttemptsSecret.some(attempt=>attempt.resultCiphertext))) {
      modelAttempts=structuredClone(op.modelAttemptsSecret);
      for(const attempt of modelAttempts)if(attempt.resultCiphertext){
        if(attempt.resultFields)throw new Error("Ambiguous model receipt");
        const response:unknown=JSON.parse(codec.decode(Buffer.from(attempt.resultCiphertext,"base64")).toString("utf8"));
        if(!response || typeof response!=="object" || Array.isArray(response))throw new Error("Invalid model receipt");
        attempt.resultFields=response as Record<string,unknown>;delete attempt.resultCiphertext;readableModelReceipts++;
      }
    }
    if (revision || removeInput || modelAttempts) changes.push({id:op.id,...(revision?{revision}:{}),removeInput,...(modelAttempts?{modelAttempts}:{})});
  }
  for (const change of changes) {
    const op=state.chatOperations[change.id]!;
    if (change.revision) {op.revisionContextFields=change.revision; delete op.revisionContextCiphertext;}
    if (change.removeInput) {delete op.inputCiphertext;delete op.inputFields;}
    if (change.modelAttempts) {op.modelAttemptsSecret=change.modelAttempts;op.contentStorageProfile="native-business-content/v1";}
  }
  return {changedOperations:changes.length,readableRevisionContexts:changes.filter(change=>change.revision).length,erasedTerminalInputs:changes.filter(change=>change.removeInput).length,readableModelReceipts};
}
