import { expect, test } from "vitest";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { nativeFields, nativeRecordIndex } from "../src/storage/firestore-native-fields.js";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import type { RuntimeRecord } from "../src/storage/execution-record-layout.js";
const scope = {projectId:"demo-lcwe-records",databaseId:"(default)",workspaceId:"native_fields"}, key = "k".repeat(32);
const codec = new FirestoreRecordCodec(key,scope,"native-fields/v1");
const record = (value:unknown):RuntimeRecord => ({profile:"runtime-record/v1",path:["domain","providers","one"],value});
const decode = (value:RuntimeRecord) => {const encoded=codec.encodeRecord(value);return {encoded, restored:codec.decodeRecord(encoded.chunks.map(chunk=>codec.decodeChunk(chunk.id,chunk.document)))};};

test.each(["modelAttemptsSecret","runtimeApprovalSecret","protectedApprovalSecret","operationSecret","protectedInvocationSecret","protectedJobSecret","protectedAgentSecret","reportPageSecret","protectedCompilationSecret"])("business journal %s is native, but nested actual credentials stay sealed",field=>{
  const value={description:"Readable reviewed business evidence",resultFields:{text:"Inventory quantity is 12",apiKey:"synthetic-nested-credential"}},source=record({[field]:value});
  const result=decode(source),raw=JSON.stringify(result.encoded.chunks[0]!.document.data);
  expect(result.restored).toEqual(source);expect(raw).toContain(value.description);expect(raw).toContain(value.resultFields.text);expect(raw).not.toContain(value.resultFields.apiKey);
  const aes=new AESGCMCodec(key),legacy={[field]:{profile:"credential-field/v1",ciphertext:aes.encode(Buffer.from(JSON.stringify(value))).toString("base64")}};
  expect(nativeFields(legacy,aes,true)).toEqual({[field]:value});
});

test("normal business fields are readable; credentials are encrypted and restore exactly", () => {
  const source = record({name:"ERP reference review",apiKey:"synthetic-private-api-key",token:"synthetic-token",config:{client_secret:"synthetic-secret"},rows:[{count:3}]});
  const {encoded,restored}=decode(source); expect(restored).toEqual(source);
  const document=encoded.chunks[0]!.document; expect(document.profile).toBe("firestore-native/v1");
  expect(JSON.stringify(document.data)).toContain("ERP reference review");
  expect(JSON.stringify(document.data)).not.toMatch(/synthetic-private-api-key|synthetic-token|synthetic-secret/);
  expect(document.payload.length).toBe(32);
});

test.each([[[1,2],[3,[4]]],[{__lcwe_nested_array_v1:[1,2]}],[{__lcwe_escaped_object_v1:{answer:1}}],JSON.parse('{"__proto__":{"answer":0},"constructor":false}')])("arbitrary JSON and reserved-looking keys round-trip without nested Firestore arrays", value => {
  expect(decode(record(value)).restored).toEqual(record(value));
});

test("unsigned field changes, wrong key/scope, and encrypted-mode readers reject native content", () => {
  const {encoded}=decode(record({answer:42})), chunk=encoded.chunks[0]!;
  const changed={...chunk.document,data:{...(chunk.document.data as object),evil:true}};
  expect(()=>codec.decodeChunk(chunk.id,changed)).toThrow();
  for(const selected of [new FirestoreRecordCodec("j".repeat(32),scope,"native-fields/v1"),new FirestoreRecordCodec(key,{...scope,workspaceId:"other"},"native-fields/v1"),new FirestoreRecordCodec(key,scope)]) expect(()=>selected.decodeChunk(chunk.id,chunk.document)).toThrow();
});

test("large business values chunk without whole-record encryption, including records with credential fields", () => {
  const plain=decode(record({businessText:"x".repeat(800_000)})); expect(plain.encoded.chunks).toHaveLength(3);
  expect(plain.encoded.chunks.every(chunk=>chunk.document.profile==="firestore-native/v1")).toBe(true);
  const secret=record({businessText:"x".repeat(800_000),apiKey:"synthetic-large-secret"}), protectedValue=decode(secret);
  expect(protectedValue.restored).toEqual(secret); expect(protectedValue.encoded.chunks.every(chunk=>chunk.document.profile==="firestore-native/v1")).toBe(true);
  const raw = protectedValue.encoded.chunks.map(chunk => Buffer.from((chunk.document.data as any).credentialFieldsBody,"base64").toString("utf8")).join("");
  expect(raw).toContain("businessText"); expect(raw).toContain("x".repeat(1000));
  expect(raw).not.toContain("synthetic-large-secret"); expect(raw).toContain("credential-field/v1");
  const decoded = protectedValue.encoded.chunks.map(chunk=>codec.decodeChunk(chunk.id,chunk.document));
  expect(()=>codec.decodeRecord(decoded.map((chunk,index)=>{if(index)return chunk;const {credentialFieldsBody,...plain}=chunk;return plain;}))).toThrow();
});

test("query metadata is plaintext and authenticated with its manifest", () => {
  const index=nativeRecordIndex(["domain","chats","chat"],{id:"chat",ownerId:"owner",updatedAt:"2026-10-16T10:00:00Z"});
  const value={profile:"fixture",key:"hash"},document=codec.encodeHead(value,index);
  expect(document.index).toMatchObject({kind:"chats",ownerId:"owner",entityId:"chat"}); expect(codec.decodeHead(document)).toEqual(value);
  expect(()=>codec.decodeHead({...document,index:{...index,ownerId:"other"}})).toThrow();
});

test("native mode can read encrypted old chunks, but it never silently decrypts legacy query metadata", () => {
  const old=new FirestoreRecordCodec(key,scope), source=record({answer:1}),encoded=old.encodeRecord(source);
  expect(codec.decodeRecord(encoded.chunks.map(chunk=>codec.decodeChunk(chunk.id,chunk.document)))).toEqual(source);
});

test("deep business JSON uses a bounded native JSON field rather than exceeding Firestore map depth",()=>{
  let value:unknown={answer:1,apiKey:"synthetic-deep-secret"};for(let i=0;i<25;i++)value={child:value};
  const source=record(value),result=decode(source);expect(result.restored).toEqual(source);
  expect((result.encoded.chunks[0]!.document.data as any).json).toEqual(expect.any(String));
  expect(JSON.stringify(result.encoded.chunks[0]!.document.data)).not.toContain("synthetic-deep-secret");
});

test.each(["apiKeys","refreshSessions","userMcpCredentials","passwordHashes"])("credential domain %s never stores raw authentication material as business fields",domain=>{
  const source={profile:"runtime-record/v1" as const,path:["domain",domain,"one"],value:{key:"synthetic-domain-secret",hash:"bcrypt-hash"}};
  const result=decode(source);expect(result.restored).toEqual(source);expect(result.encoded.chunks[0]!.document.profile).toBe("firestore-private/v1");
});

test("Firestore-reserved and long business field names preserve their exact JSON identity",()=>{
  for(const value of [JSON.parse('{"__name__":0,"__proto__":false,"lcwe_encoded_field_eA":"literal"}'),{["x".repeat(2000)]:"long field"}]) expect(decode(record(value)).restored).toEqual(record(value));
});
