import { AESGCMCodec } from "./aes-gcm.js";

// Business content is deliberately readable in the native layout. These are
// authentication material/internal continuations, not a general PII detector.
// These server-only business journals are not authentication credentials.
// Keep their contents native while still sealing any nested real credential.
const businessJournals=new Set(["modelAttemptsSecret","runtimeApprovalSecret","protectedApprovalSecret","operationSecret","protectedInvocationSecret","protectedJobSecret","protectedAgentSecret","reportPageSecret","protectedCompilationSecret"]);
const credential = (key: string) => !businessJournals.has(key) && (/^(apikey|token|accesstoken|refreshtoken|password|secret|credentials|clientsecret|authorization|bearertoken|privatekey|signingkey|encryptionkey|connectiontoken)$/i.test(key.replaceAll("_", "")) || /(?:apikey|authtoken|mcptoken|accesstoken|refreshtoken|privatekey|clientsecret|password)$/i.test(key.replaceAll("_", "")) || /(?:Ciphertext|Secret)$/.test(key));
const reserved = new Set(["__lcwe_nested_array_v1", "__lcwe_escaped_object_v1"]);
const keyPrefix="lcwe_encoded_field_";
const storedKey=(key:string)=>/^__.*__$/.test(key)||key.startsWith(keyPrefix)?keyPrefix+Buffer.from(key).toString("base64url"):key;
const originalKey=(key:string)=>key.startsWith(keyPrefix)?Buffer.from(key.slice(keyPrefix.length),"base64url").toString("utf8"):key;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Firestore refuses directly nested arrays. Preserve arbitrary JSON without
 * converting ordinary business objects/arrays to one opaque JSON string. */
export function nativeFields(value: unknown, codec: AESGCMCodec, decrypt = false, inArray = false): unknown {
  if (Array.isArray(value)) return value.map(item => {
    if (!decrypt && Array.isArray(item)) return { __lcwe_nested_array_v1: nativeFields(item, codec) };
    return nativeFields(item, codec, decrypt, true);
  });
  if (!object(value)) return value;
  if (decrypt && inArray && Object.keys(value).length === 1) {
    if (Array.isArray(value.__lcwe_nested_array_v1)) return nativeFields(value.__lcwe_nested_array_v1, codec, true);
    if (object(value.__lcwe_escaped_object_v1)) return nativeFields(value.__lcwe_escaped_object_v1, codec, true);
  }
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    const key=decrypt?originalKey(field):field;
    let next;
    if ((credential(key) || decrypt && businessJournals.has(key) && object(item) && item.profile==="credential-field/v1" && Object.keys(item).length===2) && item !== null && item !== "") {
      if (decrypt) {
        if (!object(item) || item.profile !== "credential-field/v1" || typeof item.ciphertext !== "string" || Object.keys(item).length !== 2) throw new Error("Invalid native credential field");
        next = JSON.parse(codec.decode(Buffer.from(item.ciphertext, "base64")).toString("utf8"));
      } else next = { profile: "credential-field/v1", ciphertext: codec.encode(Buffer.from(JSON.stringify(item))).toString("base64") };
    } else next = nativeFields(item, codec, decrypt);
    Object.defineProperty(result, decrypt?key:storedKey(key), { value: next, enumerable: true, writable: true, configurable: true });
  }
  return !decrypt && inArray && Object.keys(value).some(key => reserved.has(key)) ? { __lcwe_escaped_object_v1: result } : result;
}

export function containsCredentials(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentials);
  return object(value) && Object.entries(value).some(([key, child]) => credential(key) && child !== null && child !== "" || containsCredentials(child));
}
export function nativeFieldDepth(value:unknown):number {
  if(value===null||typeof value!=="object")return 0;
  let depth=0;for(const[key,child]of Object.entries(value)){if(Buffer.byteLength(key)>1400)return 100;depth=Math.max(depth,nativeFieldDepth(child));}return depth+1;
}

export type NativeRecordIndex = { kind: string; entityId: string; ownerId: string; updatedAt: string; chatId: string; sequence: number; status: string };
export function nativeRecordIndex(path: string[], value: unknown): NativeRecordIndex {
  const row = object(value) ? value : {};
  const text = (input: unknown) => typeof input === "string" ? input : "";
  const owner = object(row.owner) ? row.owner.id : undefined;
  return { kind: path[0] === "domain" ? text(path[1]) : text(path[0]), entityId: text(row.id) || text(path[2]) || text(path[1]),
    ownerId: text(row.ownerId) || text(owner) || text(row.recipientId) || text(row.userId),
    updatedAt: text(row.updatedAt) || text(row.createdAt) || text(row.timestamp) || text(row.startedAt),
    chatId: path[0] === "chat-message" ? text(path[1]) : text(row.chatSessionId),
    sequence: path[0] === "chat-message" ? Number(path[2]) : -1, status: text(row.status) };
}
