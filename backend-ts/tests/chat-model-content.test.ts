import {expect,test} from "vitest";
import type {ChatModelAttempt} from "../src/repository/store.js";
import {storeChatModelContent} from "../src/storage/chat-model-content.js";
import {AESGCMCodec} from "../src/storage/aes-gcm.js";
const codec=new AESGCMCodec("k".repeat(32));
const attempt=()=>({id:"receipt",status:"DISPATCH_INTENT"} as ChatModelAttempt);
test("native model receipts keep response text readable and never generate a whole-result ciphertext",()=>{
 const target=attempt(),response={text:"There are 12 units",toolCalls:[]},bytes=Buffer.from(JSON.stringify(response));
 storeChatModelContent([target],target,bytes,true,codec);
 expect(target.resultFields).toEqual(response);expect(target.resultCiphertext).toBeUndefined();expect(target.status).toBe("DISPATCH_INTENT");
});
test("legacy receipt format remains explicit and readable by the legacy codec",()=>{
 const target=attempt(),bytes=Buffer.from('{"text":"Legacy receipt"}');storeChatModelContent([target],target,bytes,false,codec);
 expect(codec.decode(Buffer.from(target.resultCiphertext!,"base64"))).toEqual(bytes);expect(target.resultFields).toBeUndefined();
});
test("receipt limits account for both native and legacy result sizes before changing the target",()=>{
 const target=attempt();
 expect(()=>storeChatModelContent([target],target,Buffer.alloc(256_001),true,codec)).toThrow("budget");expect(target.resultFields).toBeUndefined();
 for(const old of [{resultCiphertext:"x".repeat(900_000)},{resultFields:{text:"x".repeat(900_000)}}]){
  expect(()=>storeChatModelContent([{...attempt(),...old}],target,Buffer.from(JSON.stringify({text:"x".repeat(60_000)})),true,codec)).toThrow("budget");
 }
 expect(target.resultFields).toBeUndefined();
});
