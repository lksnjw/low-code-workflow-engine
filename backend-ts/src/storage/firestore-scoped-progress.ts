import type { RepositoryState } from "../repository/store.js";
import { effectiveUserFromState } from "../repository/store.js";
import type { ScopedFirestoreReader } from "./firestore-record-store.js";
import { summarizeChatForReads } from "./chat-read-summary.js";
import { canReviewChat, chatAccess } from "../http/chat-scope.js";
import { chatSummary, projectChatMessagePage } from "../http/handlers/chat-sessions.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { assembleRuntimeState, executionRecordScope, type RuntimeRecord } from "./execution-record-layout.js";

export type ScopedProgressRequest = {path: string; id?: string; query: Record<string, unknown>};
export type ScopedProgressView = {state: RepositoryState; chatPage?: {items: Record<string,unknown>[]; meta: Record<string,unknown>}; messagePage?: Record<string,unknown>};
const fixed = new Set(["/api/auth/me","/api/chat/models","/api/chat/capabilities","/api/chat/sessions","/api/notifications","/api/pipeline/v1/library/catalog","/api/pipeline/v1/library/inventory",
  "/api/chat/sessions/:id","/api/chat/sessions/:id/operations","/api/chat/operations/:id","/api/chat/sessions/:id/attachments","/api/chat/sessions/:id/attachments/:uploadId",
  "/api/workflows","/api/workflows/:id","/api/workflows/:id/yaml","/api/executions","/api/executions/:id","/api/executions/:id/events","/api/executions/:id/logs","/api/executions/:id/timeline","/api/execution-reviews","/api/dashboard/tasks"]);
export const supportsScopedProgress = (path:string,query:Record<string,unknown>={}) => fixed.has(path) && !(path==="/api/executions"&&query.traceId!==undefined);
const integer=(value:unknown,fallback:number,max=200)=>{
  if(value===undefined)return fallback;
  if(typeof value!=="string"||!/^\d{1,12}$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>max)throw new HandlerFailure(400,"Invalid page size");
  return Number(value);
};

/** Read-only partial state. Never call restoreState/initialState here: default
 * roles must not invent authority, and this view must never enter a writer. */
export async function scopedProgressView(reader:ScopedFirestoreReader, actorId:string, request:ScopedProgressRequest):Promise<ScopedProgressView> {
  if(!supportsScopedProgress(request.path))throw new Error("Unsupported scoped progress view");
  const state={version:1,users:{},roles:{},chats:{},chatOperations:{},chatOperationEvents:{},workflows:{},versions:{},executions:{},providers:{},notifications:{},settings:{},schedules:{},scheduleOccurrences:{},timelines:{},executionLogs:{},executionEvents:{}} as RepositoryState;
  const entries=reader.entries;
  const domain=async(kind:string,ids?:string[])=>{
    const paths=ids?ids.map(id=>kind==="executions"?[kind,id]:["domain",kind,id]):entries.filter(entry=>entry.path[0]==="domain"&&entry.path[1]===kind&&entry.path.length===3).map(entry=>entry.path);
    const rows=await reader.read(paths);
    const target=(state as unknown as Record<string,Record<string,unknown>>)[kind] ??= {};
    for(const row of rows)if(row)target[row.path[kind==="executions"?1:2]!]=row.value;
  };
  await domain("users",[actorId]);
  const account=state.users[actorId];
  if(!account)return{state};
  if(account.id!==actorId||typeof account.roleId!=="string"||!Array.isArray(account.permissionOverrides))throw new Error("Invalid scoped account record");
  await domain("roles",[account.roleId]);
  const role=state.roles[account.roleId];
  if(role&&(!Array.isArray(role.permissions)||role.id!==account.roleId))throw new Error("Invalid scoped role record");
  const user=effectiveUserFromState(state,actorId)!;
  if(account.status.toLowerCase()!=="active")return{state};
  if(request.path==="/api/chat/models")await domain("providers");
  if(request.path==="/api/notifications") {
    await domain("notifications",entries.filter(entry=>entry.path[0]==="domain"&&entry.path[1]==="notifications"&&entry.index?.ownerId===actorId).map(entry=>entry.path[2]!));
  }
  if(request.path.startsWith("/api/workflows")||request.path.startsWith("/api/executions")||request.path==="/api/execution-reviews"||request.path==="/api/dashboard/tasks"){
    const workflowDetail=request.path.startsWith("/api/workflows/:id");
    await domain("workflows",workflowDetail?[request.id!]:undefined);
    const executionDetail=request.path.startsWith("/api/executions/:id");
    const executionIds=entries.filter(entry=>entry.path[0]==="executions"&&(!executionDetail||entry.path[1]===request.id)).map(entry=>entry.path[1]!);
    const cores=await reader.read(executionIds.map(id=>["executions",id]));
    for(const record of cores)if(record)state.executions[record.path[1]!]=record.value as RepositoryState["executions"][string];
    if(executionDetail||request.path==="/api/execution-reviews"){
      const wanted=new Set(executionIds), paths=entries.filter(entry=>wanted.has(executionRecordScope({profile:"runtime-record/v1",path:entry.path,value:null})??"")).map(entry=>entry.path);
      const records=(await reader.read(paths)).filter((row):row is RuntimeRecord=>row!==null);
      const root={...state} as unknown as Record<string,unknown>;
      for(const field of ["executions","readJobs","readContinuations","protectedContinuations","timelines","executionLogs","executionEvents","auditLogs"])delete root[field];
      const runtime=assembleRuntimeState([{profile:"runtime-record/v1",path:["root"],value:root},{profile:"runtime-record/v1",path:["auditLogs"],value:0},...records]);
      Object.assign(state,{executions:runtime.executions,timelines:runtime.timelines,executionLogs:runtime.executionLogs,executionEvents:runtime.executionEvents});
    }
    const workflowIds=workflowDetail?[request.id!]:executionDetail?[...new Set(Object.values(state.executions).map(run=>run.workflowId))]:[];
    if(executionDetail)await domain("workflows",workflowIds);
    for(const id of workflowIds){
      const head=(await reader.read([["domain","versions",id]]))[0];if(!head)continue;
      const count=Number(head.value);if(!Number.isSafeInteger(count)||count<0||count>10000)throw new Error("Invalid scoped workflow versions");
      state.versions[id]=(await reader.read(Array.from({length:count},(_,i)=>["workflow-version",id,String(i)]))).map(row=>{if(!row)throw new Error("Missing workflow version");return row.value as RepositoryState["versions"][string][number];});
    }
    if(request.path==="/api/execution-reviews"){
      await domain("users");await domain("roles");await domain("settings");
    }
    if(request.path==="/api/dashboard/tasks"){await domain("schedules");await domain("scheduleOccurrences");}
    return{state};
  }
  if(request.path==="/api/chat/sessions") {
    const limit=integer(request.query.limit,20), page=integer(request.query.page,1,1_000_000);
    const candidates=entries.filter(entry=>entry.path[0]==="domain"&&entry.path[1]==="chats"&&(user.role==="Platform Admin"||entry.index?.ownerId===actorId))
      .sort((a,b)=>(b.index?.updatedAt??"").localeCompare(a.index?.updatedAt??"")||(a.index?.entityId??"").localeCompare(b.index?.entityId??""));
    let start=(page-1)*limit;
    if(request.query.after!==undefined){
      try {
        if(typeof request.query.after!=="string"||request.query.after.length>1024)throw new Error();
        const cursor=JSON.parse(Buffer.from(request.query.after,"base64url").toString());
        if(!cursor||Object.keys(cursor).sort().join("|")!=="entityId|updatedAt")throw new Error();
        const at=candidates.findIndex(entry=>entry.index?.entityId===cursor.entityId&&entry.index?.updatedAt===cursor.updatedAt);
        if(at<0)throw new Error();start=at+1;
      }catch{throw new HandlerFailure(400,"Conversation cursor changed. Reload the first page.",{code:"CHAT_LIST_CURSOR_INVALID"});}
    }
    const selected=candidates.slice(start,start+limit);
    await domain("chats",selected.map(entry=>entry.path[2]!));
    const items=selected.map(entry=>state.chats[entry.path[2]!]!).filter(chat=>canReviewChat(user,chat)).map(chat=>({...chatSummary(chat),access:chatAccess(user,chat)}));
    const last=selected.at(-1)?.index;
    const nextCursor=start+limit<candidates.length&&last?Buffer.from(JSON.stringify({updatedAt:last.updatedAt,entityId:last.entityId})).toString("base64url"):null;
    return{state,chatPage:{items,meta:{page,limit,total:candidates.length,totalPages:Math.ceil(candidates.length/limit),nextCursor,indexed:true}}};
  }
  let chatId=request.path.startsWith("/api/chat/sessions/")?request.id:undefined;
  if(request.path==="/api/chat/operations/:id"){
    await domain("chatOperations",[request.id!]);const op=state.chatOperations[request.id!];
    if(op?.actorId===actorId)chatId=op.sessionId;else{state.chatOperations={};return{state};}
  }
  if(!chatId)return{state};
  await domain("chats",[chatId]);const chat=state.chats[chatId];
  if(!chat||!canReviewChat(user,chat)){state.chats={};return{state};}
  if(request.path==="/api/chat/sessions/:id"){
    const limit=integer(request.query.limit,20);
    const paths=entries.filter(entry=>entry.path[0]==="chat-message"&&entry.path[1]===chatId).sort((a,b)=>Number(a.path[2])-Number(b.path[2]));
    const countRecord=(await reader.read([["chat-messages",chatId]]))[0], total=Number(countRecord?.value);
    if(!Number.isSafeInteger(total)||total<0||paths.length!==total||paths.some((entry,index)=>Number(entry.path[2])!==index))throw new Error("Scoped message sequence is incomplete");
    let end=total;
    if(request.query.before!==undefined){
      if(typeof request.query.before!=="string"||!request.query.before.trim()||request.query.before.length>128)throw new HandlerFailure(400,"Invalid earlier-message cursor",{code:"CHAT_HISTORY_CURSOR_INVALID"});
      end=paths.findIndex(entry=>entry.index?.entityId===request.query.before);
      if(end<0)throw new HandlerFailure(400,"The earlier-message cursor is not in this conversation. Reload before loading older messages.",{code:"CHAT_HISTORY_CURSOR_INVALID"});
    }
    const start=Math.max(0,end-limit);
    // Legacy chats are upgraded on their next acknowledged mutation. Their
    // one-chat fallback preserves old workflow/email identity, not all chats.
    const rows=await reader.read((chat.readSummary?paths.slice(start,end):paths).map(entry=>entry.path));
    const messages=rows.map(row=>{if(!row)throw new Error("Scoped message is missing");return row.value as Record<string,unknown>;});
    if(!chat.readSummary){chat.messages=messages;chat.readSummary=summarizeChatForReads(chat);}
    if(chat.readSummary.messageCount!==total)throw new Error("Stored chat summary needs refresh");
    const page=chat.messages.length?messages.slice(start,end):messages;
    chat.messages=page;
    const linked=entries.filter(entry=>entry.path[0]==="domain"&&entry.path[1]==="workflows"&&entry.index?.chatId===chatId).map(entry=>entry.path[2]!);
    await domain("workflows",[...new Set([...linked,...chat.readSummary.workflows.map(item=>item.workflowId)])]);
    await domain("chatOperations",page.flatMap(message=>typeof message.operationId==="string"?[message.operationId]:[]));
    const executions=page.flatMap(message=>{const a=message.artifacts as {emailDelivery?:{executionId?:unknown}}|undefined;return typeof a?.emailDelivery?.executionId==="string"?[a.emailDelivery.executionId]:[];});
    await domain("executions",executions);
    for(const execution of Object.values(state.executions))if(execution.operationSecret){
      const intents=await reader.read(entries.filter(entry=>entry.path[0]==="operation-intents"&&entry.path[1]===execution.id).map(entry=>entry.path));
      for(const row of intents)if(row)execution.operationSecret.intents[row.path[2]!]=row.value as typeof execution.operationSecret.intents[string];
    }
    return{state,messagePage:projectChatMessagePage(state,chat,user,page,start,total)};
  }
  if(request.path==="/api/chat/sessions/:id/operations"){
    let ids=chat.readSummary?.operationIds;
    if(!ids){
      const messages=await reader.read(entries.filter(entry=>entry.path[0]==="chat-message"&&entry.path[1]===chatId).map(entry=>entry.path));
      ids=messages.flatMap(row=>{const value=row?.value as {operationId?:unknown}|undefined;return typeof value?.operationId==="string"?[value.operationId]:[];});
    }
    await domain("chatOperations",[...new Set(ids)]);
  }
  for(const op of Object.values(state.chatOperations)){
    if(op.nodeContext)await domain("workflows",[op.nodeContext.workflowId]);
    if(request.path!=="/api/chat/operations/:id")continue;
    const count=(await reader.read([["domain","chatOperationEvents",op.id]]))[0];
    const length=Number(count?.value??0);
    if(!Number.isSafeInteger(length)||length<0||length>10000)throw new Error("Invalid scoped operation events");
    const records=await reader.read(Array.from({length},(_,index)=>["chat-operation-event",op.id,String(index)]));
    state.chatOperationEvents[op.id]=records.map(row=>{if(!row)throw new Error("Scoped event is missing");return row.value as RepositoryState["chatOperationEvents"][string][number];});
  }
  return{state};
}
