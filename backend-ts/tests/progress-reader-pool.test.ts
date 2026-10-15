import {expect,test,vi} from "vitest";
import {ProgressReaderPool} from "../src/firebase/progress-reader-pool.js";
import {loadConfig} from "../src/config/config.js";
import type {RepositoryState} from "../src/repository/store.js";
const config=()=>({...loadConfig({APP_ENV:"test",STORAGE_DRIVER:"memory"}),firestoreProjectId:"demo-lcwe-records",firestoreDatabaseId:"(default)",firestoreWorkspaceId:"pool",storageEncryptionKey:"k".repeat(32)});
test("warm reads reuse only the client; every call revalidates committed state including revocation",async()=>{
  const snapshot=vi.fn().mockResolvedValueOnce({counter:1}).mockResolvedValueOnce({counter:2}),close=vi.fn(async()=>{}),open=vi.fn(()=>({snapshot,close}));
  const pool=new ProgressReaderPool(open),a=pool.borrow(config());expect(await a.snapshot()).toEqual({counter:1});await a.close();
  const b=pool.borrow(config());expect(await b.snapshot()).toEqual({counter:2});await b.close();
  expect(open).toHaveBeenCalledTimes(1);expect(snapshot).toHaveBeenCalledTimes(2);expect(close).not.toHaveBeenCalled();await pool.close();expect(close).toHaveBeenCalledTimes(1);
});
test("key/namespace/layout changes never adopt another scope's loaded image",async()=>{
  const open=vi.fn(()=>({snapshot:vi.fn(async()=>({}) as RepositoryState),close:vi.fn(async()=>{})}));const pool=new ProgressReaderPool(open);
  const a=pool.borrow(config());await a.close();const b=pool.borrow({...config(),firestoreWorkspaceId:"other"});await b.close();
  const c=pool.borrow({...config(),firestoreContentFormat:"native-fields/v1"});await c.close();expect(open).toHaveBeenCalledTimes(3);await pool.close();
});
test("a failed head read discards the client and never falls back to stale data",async()=>{
  const first={snapshot:vi.fn(async()=>{throw new Error("head mismatch");}),close:vi.fn(async()=>{})};
  const second={snapshot:vi.fn(async()=>({counter:2}) as RepositoryState),close:vi.fn(async()=>{})};
  const pool=new ProgressReaderPool(vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)),a=pool.borrow(config());
  await expect(a.snapshot()).rejects.toThrow("head mismatch");await a.close();expect(first.close).toHaveBeenCalledOnce();
  const b=pool.borrow(config());expect(await b.snapshot()).toEqual({counter:2});await b.close();await pool.close();
});
test("active borrowers are not evicted or granted an unbounded number of clients",async()=>{
  const pool=new ProgressReaderPool(()=>({snapshot:async()=>({}) as RepositoryState,close:async()=>{}}),1),a=pool.borrow(config());
  expect(()=>pool.borrow({...config(),firestoreWorkspaceId:"other"})).toThrow("capacity");await expect(pool.close()).rejects.toThrow("borrowed");await a.close();await pool.close();
});
