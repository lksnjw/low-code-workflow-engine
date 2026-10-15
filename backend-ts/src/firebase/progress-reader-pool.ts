import { createHash } from "node:crypto";
import type { AppConfig } from "../config/config.js";
import { openFirestoreProgressReader, type ProgressSnapshotReader } from "../storage/firestore-progress-reader.js";

type Entry = { reader: ProgressSnapshotReader; users: number; failed: boolean };
/** Warm-process READ-ONLY connection/image reuse. This never pools a writable
 * repository, execution host, user permission decision or application runtime.
 * Each snapshot still reads and authenticates the current committed head. */
export class ProgressReaderPool {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly open = openFirestoreProgressReader, private readonly capacity = 2) {}
  borrow(config: AppConfig): ProgressSnapshotReader {
    const key = createHash("sha256").update(JSON.stringify([config.firestoreProjectId,config.firestoreDatabaseId,
      config.firestoreWorkspaceId,config.storageEncryptionKey,config.firestoreContentFormat,config.firestoreKeyFile,config.firestoreKeyJson])).digest("hex");
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        const idle = [...this.entries].find(([,value])=>value.users===0);
        if (!idle) throw new Error("Read-only connection capacity is busy");
        this.entries.delete(idle[0]); void idle[1].reader.close().catch(()=>{});
      }
      entry={reader:this.open(config),users:0,failed:false};this.entries.set(key,entry);
    }
    entry.users++;const selected=entry;let released=false;
    const active=()=>{if(released||selected.failed) throw new Error("Committed reader lease is unavailable");};
    const call=async<T>(work:()=>Promise<T>)=>{
      active();try{return await work();}catch(error){selected.failed=true;if(this.entries.get(key)===selected)this.entries.delete(key);throw error;}
    };
    return {
      snapshot:options=>call(()=>selected.reader.snapshot(options)),
      ...(selected.reader.scoped?{scoped:(actorId,request,signal)=>call(()=>selected.reader.scoped!(actorId,request,signal))}:{}),
      ...(selected.reader.probe?{probe:()=>call(()=>selected.reader.probe!())}:{}),
      ...(selected.reader.cancellationRequested?{cancellationRequested:(operation,signal)=>call(()=>selected.reader.cancellationRequested!(operation,signal))}:{}),
      ...(selected.reader.metadataPage?{metadataPage:(state,kind,ownerId,limit,after)=>call(()=>selected.reader.metadataPage!(state,kind,ownerId,limit,after))}:{}),
      close:async()=>{if(released)return;released=true;selected.users--;if(selected.failed&&selected.users===0)await selected.reader.close();},
    };
  }
  async close():Promise<void>{const values=[...this.entries.values()];if(values.some(value=>value.users>0))throw new Error("Read-only clients are still borrowed");this.entries.clear();await Promise.all(values.map(value=>value.reader.close()));}
}
const pool = new ProgressReaderPool();
export const borrowProgressReader = (config: AppConfig) => pool.borrow(config);
