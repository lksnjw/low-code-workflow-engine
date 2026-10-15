import {beforeEach,expect,test,vi} from "vitest";
const runtime=vi.hoisted(()=>({db:null as any}));
vi.mock("@google-cloud/firestore",()=>({Firestore:class{constructor(settings:any){return new FakeClient(runtime.db,settings);}}}));
import {Database,FakeClient} from "./fixtures/fake-firestore.js";
import {FirestoreRecordStore} from "../src/storage/firestore-record-store.js";
import {FirestoreRecordCodec} from "../src/storage/firestore-record-codec.js";
import {splitFirestoreState} from "../src/storage/firestore-record-layout.js";
import {scopedProgressView} from "../src/storage/firestore-scoped-progress.js";
import {summarizeChatForReads} from "../src/storage/chat-read-summary.js";
import {initialState,Repository,type ChatSessionRecord} from "../src/repository/store.js";
const scope={projectId:"demo-lcwe-records",databaseId:"(default)",workspaceId:"scoped_progress"},key="p".repeat(32);
let db:Database;
beforeEach(()=>{db=new Database();runtime.db=db;});
function chat(id:string,ownerId:string,count:number):ChatSessionRecord{
  const value={id,ownerId,title:id,createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-18T01:00:00Z",messageCount:count,
    messages:Array.from({length:count},(_,i)=>({id:`${id}-message-${i}`,role:i%2?"assistant":"user",text:`${id} ${i} `+"x".repeat(2000)}))};
  return{...value,readSummary:summarizeChatForReads(value)};
}
async function setup(){
  const state=initialState();state.users.actor={id:"actor",roleId:"role_builder",name:"Owner",email:"owner@example.invalid",status:"Active",permissionOverrides:[],initials:"OW",departmentId:null,lastLoginAt:null,createdAt:"2026-10-01T00:00:00Z"};
  state.chats.mine=chat("mine","actor",65);state.chats.other=chat("other","someone-else",80);
  const store=FirestoreRecordStore.create(key,scope,{},"native-fields/v1");
  await store.initializeStaged(splitFirestoreState(state),"scoped-fixture");db.reads=[];
  return{store,state};
}
const bodies=()=>db.reads.filter(path=>path.includes("/lcwe_record_chunks/"));
test("account screen reads only account and role bodies, never chat messages or full state",async()=>{
  const{store}=await setup();const view=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/auth/me",query:{}}));
  expect(view.state.users.actor?.id).toBe("actor");expect(view.state.roles.role_builder).toBeDefined();expect(view.state.chats).toEqual({});expect(bodies()).toHaveLength(2);
  db.reads=[];await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/auth/me",query:{}}));
  expect(db.reads).not.toContain(store.collectionPath);expect(bodies()).toHaveLength(2);await store.close();
});
test("chat opens newest 20 from database, earlier messages are fetched only by cursor",async()=>{
  const{store}=await setup();const first=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/chat/sessions/:id",id:"mine",query:{}}));
  expect(first.messagePage).toMatchObject({totalMessageCount:65,hasMoreMessages:true});
  expect((first.messagePage!.messages as any[]).map(m=>m.id)).toEqual(Array.from({length:20},(_,i)=>`mine-message-${i+45}`));
  expect(bodies()).toHaveLength(24);expect(JSON.stringify(first)).not.toContain("other-message");
  db.reads=[];const older=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/chat/sessions/:id",id:"mine",query:{before:"mine-message-45"}}));
  expect((older.messagePage!.messages as any[])[0].id).toBe("mine-message-25");expect(bodies()).toHaveLength(24);await store.close();
});
test("private chat cannot fetch any message bodies, even with a valid cursor from it",async()=>{
  const{store}=await setup();const view=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/chat/sessions/:id",id:"other",query:{before:"other-message-50"}}));
  expect(view.state.chats).toEqual({});expect(view.messagePage).toBeUndefined();expect(bodies()).toHaveLength(3);await store.close();
});
test("chat history lists summaries without downloading message bodies or private chats",async()=>{
  const{store}=await setup();const view=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/chat/sessions",query:{limit:"20"}}));
  expect(view.chatPage?.items).toHaveLength(1);expect(view.chatPage?.items[0]).toMatchObject({id:"mine",summary:expect.stringContaining("mine 64")});
  expect(view.chatPage?.items[0]).not.toHaveProperty("messages");expect(view.chatPage?.items[0]).not.toHaveProperty("readSummary");expect(bodies()).toHaveLength(3);await store.close();
});
test("role revocation is read freshly and never restored from cached authorization",async()=>{
  const{store,state}=await setup();await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/auth/me",query:{}}));
  const current=await store.load();await store.commit(current,{transitionId:"revoke-scoped",upsert:[{profile:"runtime-record/v1",path:["domain","roles","role_builder"],value:{...state.roles.role_builder,permissions:[]}}]});
  const next=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/auth/me",query:{}}));expect(next.state.roles.role_builder?.permissions).toEqual([]);await store.close();
});
test("retired signed manifests cannot be replayed under a different committed head",async()=>{
  const{store,state}=await setup();const codec=new FirestoreRecordCodec(key,scope,"native-fields/v1"),id=codec.manifestId(JSON.stringify(["domain","roles","role_builder"])),path=store.collectionPath+"/"+id;
  const old=db.documents.get(path),current=await store.load();await store.commit(current,{transitionId:"revoke-manifest",upsert:[{profile:"runtime-record/v1",path:["domain","roles","role_builder"],value:{...state.roles.role_builder,permissions:[]}}]});
  db.documents.set(path,old);await expect(store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/auth/me",query:{}}))).rejects.toThrow("differs from authenticated head");await store.close();
});
test("summaries are persisted with acknowledged chat changes without another model request",async()=>{
  const repo=await Repository.open(null);await repo.mutate(state=>{state.chats.mine=chat("mine","actor",2);});
  await repo.mutate(state=>{state.chats.mine!.messages.push({id:"new",role:"assistant",text:"Saved result"});state.chats.mine!.updatedAt="2026-10-18T02:00:00Z";});
  expect((await repo.snapshot()).chats.mine!.readSummary).toMatchObject({messageCount:3,lastMessageId:"new",preview:"Saved result"});await repo.close();
});
test("legacy chat fallback is limited to that chat and preserves old workflow choices",async()=>{
  const{store,state}=await setup();const mine=state.chats.mine!;delete mine.readSummary;
  mine.messages[0]!.artifacts={workflowId:"old_workflow"};
  const workflow={id:"old_workflow",name:"Saved earlier workflow",owner:{id:"actor"},assignedUserIds:[],archived:false};
  await store.commit(await store.load(),{transitionId:"legacy-chat",upsert:[{profile:"runtime-record/v1",path:["domain","chats","mine"],value:{...mine,messages:[]}},
    {profile:"runtime-record/v1",path:["chat-message","mine","0"],value:mine.messages[0]},
    {profile:"runtime-record/v1",path:["domain","workflows","old_workflow"],value:workflow}]});
  db.reads=[];const result=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/chat/sessions/:id",id:"mine",query:{}}));
  expect(result.messagePage?.workflowCatalog).toEqual([{workflowId:"old_workflow",name:"Saved earlier workflow",lastMessageIndex:0}]);
  expect((result.messagePage!.messages as any[])).toHaveLength(20);expect(bodies()).toHaveLength(70);await store.close();
});
test("summaries retain older workflow and email supersession metadata without fetching old messages",async()=>{
  const{store,state}=await setup();const mine=state.chats.mine!;
  mine.messages[0]!.artifacts={workflowId:"saved_workflow",retrieval:{large:"old"},emailDraft:{id:"draft"}};
  mine.messages[64]!.artifacts={retrieval:{large:"new"},emailDraft:{id:"draft"}};mine.readSummary=summarizeChatForReads(mine);
  await store.commit(await store.load(),{transitionId:"summarized-artifacts",upsert:[{profile:"runtime-record/v1",path:["domain","chats","mine"],value:{...mine,messages:[]}},
    ...[0,64].map(index=>({profile:"runtime-record/v1" as const,path:["chat-message","mine",String(index)],value:mine.messages[index]})),
    {profile:"runtime-record/v1",path:["domain","workflows","saved_workflow"],value:{id:"saved_workflow",name:"Saved",owner:{id:"actor"},archived:false}}]});
  db.reads=[];const result=await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/chat/sessions/:id",id:"mine",query:{before:"mine-message-20"}}));
  expect((result.messagePage!.messages as any[])[0].artifacts).toMatchObject({emailDraftSuperseded:true});
  expect((result.messagePage!.messages as any[])[0].artifacts).not.toHaveProperty("retrieval");
  expect(result.messagePage!.workflowCatalog).toMatchObject([{workflowId:"saved_workflow"}]);expect(bodies()).toHaveLength(25);await store.close();
});
test("workflow and review screens do not load chat bodies",async()=>{
  const{store}=await setup();await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/workflows",query:{}}));
  expect(bodies()).toHaveLength(2);db.reads=[];
  await store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/execution-reviews",query:{}}));
  expect(bodies().length).toBeLessThan(10);await store.close();
});
test("malformed or cross-chat cursors cannot select unrelated message bodies",async()=>{
  const{store}=await setup();await expect(store.readScoped(reader=>scopedProgressView(reader,"actor",{path:"/api/chat/sessions/:id",id:"mine",query:{before:"other-message-20"}}))).rejects.toMatchObject({status:400});
  expect(bodies()).toHaveLength(4);await store.close();
});
test("summary previews redact credential-looking text and cannot claim tool execution",()=>{
  const value=chat("secret","actor",1);value.messages[0]!.text="password=hunter2 Bearer abcdefghi sk-or-v1-"+"a".repeat(40);
  const summary=summarizeChatForReads(value);expect(summary.preview).not.toContain("hunter2");expect(summary.preview).not.toContain("abcdefghi");expect(summary.preview).not.toContain("a".repeat(40));
  expect(summary).not.toHaveProperty("approved");expect(summary).not.toHaveProperty("executionStatus");
});
