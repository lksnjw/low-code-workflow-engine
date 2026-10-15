import { EventEmitter } from "node:events";
export const clone = (value: any) => value && { ...value, payload: Buffer.isBuffer(value.payload) ? Buffer.from(value.payload) : value.payload };
/** Public GAPIC surface only; shared by cancellation authority/task fixtures. */
export class FakeStopClient {
  static hold = false;
  static onRead: ((request: any, stream: ReturnType<FakeStopClient["batchGetDocuments"]>, client: FakeStopClient) => boolean) | undefined;
  static instances: FakeStopClient[] = [];
  closed = false; calls = 0; cancels = 0;
  locationsClient = { initialize: async () => ({}), close: async () => {} };
  constructor(readonly database: Database, readonly settings: any) { FakeStopClient.instances.push(this); }
  async initialize() { return {}; }
  async close() { this.closed = true; }
  batchGetDocuments(request: any, _options: any) {
    this.calls++; const stream = Object.assign(new EventEmitter(), { cancel: () => {
      this.cancels++; queueMicrotask(() => { stream.emit("status", { code: 1 }); stream.emit("close"); });
    } });
    if (FakeStopClient.onRead?.(request, stream, this)) return stream;
    queueMicrotask(() => {
      if (FakeStopClient.hold) return;
      const name = request.documents[0], path = name.split("/documents/")[1], document = this.database.documents.get(path);
      stream.emit("data", document ? { found: { name, fields: { profile: { stringValue: document.profile }, payload: { bytesValue: document.payload } } } } : { missing: name });
      stream.emit("status", { code: 0 }); stream.emit("end");
    });
    return stream;
  }
}
export class Database {
  documents = new Map<string, any>(); serverTime = Date.now(); version = 0; callbacks = 0; invocations = 0;
  fault: "retry" | "before-commit" | "after-commit" | null = null;
  writes: Array<Array<{ path: string; data: any }>> = []; reads: string[] = []; settings: any[] = [];
  staged: string[] = []; stageFaultAt = -1; stageHook: (() => Promise<void>) | null = null;
}
export class FakeClient {
  closed = false; constructor(readonly database: Database, readonly settings: any) { database.settings.push(settings); }
  get databaseId() { return this.settings.databaseId; }
  doc(path: string) { return { path,
    get: async () => ({ readTime: { toMillis: () => this.database.serverTime }, exists: this.database.documents.has(path), data: () => clone(this.database.documents.get(path)) }),
    create: async (value: any) => {
      if (this.closed) throw new Error("closed");
      this.database.staged.push(path);
      if (this.database.staged.length === this.database.stageFaultAt) throw new Error("synthetic staging failure");
      if (this.database.stageHook) await this.database.stageHook();
      if (this.database.documents.has(path)) throw Object.assign(new Error("already exists"), { code: 6 });
      this.database.documents.set(path, clone(value)); this.database.version++;
    },
  }; }
  collection(path: string) {
    const build = (filters:any[]=[],orders:any[]=[],after:any[]|undefined=undefined,limit=Infinity):any => ({path,maxRows:limit,query:true,filters,orders,after,
      doc:(id:string)=>this.doc(`${path}/${id}`), where:(field:string,op:string,value:unknown)=>{if(op!=="==") throw new Error("Unsupported fixture operator");return build([...filters,[field,value]],orders,after,limit);},
      orderBy:(field:string,direction="asc")=>build(filters,[...orders,[field,direction]],after,limit), startAfter:(...values:any[])=>build(filters,orders,values,limit), limit:(size:number)=>build(filters,orders,after,size)});
    return build();
  }
  async terminate() { this.closed = true; }
  async runTransaction(callback: (tx: any) => Promise<unknown>, options: any) {
    this.database.invocations++;
    for (let attempt = 0; attempt < (options.maxAttempts ?? 1); attempt++) {
      if (this.closed) throw new Error("closed");
      const start = this.database.version, image = new Map(this.database.documents), writes: Array<{ path: string; data: any }> = [];
      const readTime = this.database.serverTime;
      const row = (ref: any) => ({ readTime: { toMillis: () => readTime }, id: ref.path.split("/").at(-1), exists: image.has(ref.path), data: () => clone(image.get(ref.path)) });
      const read = () => { if (writes.length) throw new Error("SDK disallows reads after writes"); };
      const tx = {
        get: async (ref: any) => { read(); this.database.reads.push(ref.path);
          if (!ref.query) return row(ref);
          const field = (path:string,key:string) => key.split(".").reduce((value,part)=>value?.[part],image.get(path));
          const compare = (left:string,right:string|any[],cursor=false) => {
            for(let i=0;i<(ref.orders??[]).length;i++) {const [name,direction]=ref.orders[i],a=field(left,name),b=cursor?(right as any[])[i]:field(right as string,name);const order=a<b?-1:a>b?1:0;if(order) return direction==="desc"?-order:order;}
            return cursor?0:left.localeCompare(right as string);
          };
          const docs = [...image.keys()].filter(path => path.startsWith(ref.path + "/") && !path.slice(ref.path.length + 1).includes("/") && (ref.filters??[]).every(([key,value]:any[])=>field(path,key)===value))
            .sort((a,b)=>compare(a,b)).filter(path=>!ref.after || compare(path,ref.after,true)>0).slice(0, ref.maxRows ?? ref.limit).map(path => row({ path }));
          return { docs, size: docs.length, empty: !docs.length };
        },
        getAll: async (...refs: any[]) => { read(); this.database.reads.push(...refs.map(ref => ref.path)); return refs.map(row); },
        set: (ref: any, value: any) => { writes.push({ path: ref.path, data: clone(value) }); image.set(ref.path, clone(value)); },
        delete: (ref: any) => { writes.push({ path: ref.path, data: null }); image.delete(ref.path); },
      };
      this.database.callbacks++; const result = await callback(tx); this.database.writes.push(writes);
      if (options.readOnly) { if (writes.length) throw new Error("read-only write"); return result; }
      if (this.database.fault === "retry") { this.database.fault = null; continue; }
      if (this.database.fault === "before-commit") { this.database.fault = null; throw new Error("commit unconfirmed"); }
      if (this.database.version !== start) continue;
      if (writes.length) { this.database.documents = image; this.database.version++; }
      if (this.database.fault === "after-commit") { this.database.fault = null; throw new Error("commit acknowledgement lost"); }
      return result;
    }
    throw new Error("retry budget exhausted");
  }
}
