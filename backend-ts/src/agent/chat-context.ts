import type { RepositoryState, StoredRecord } from "../repository/store.js";

export type ChatProcessingHooks = {
  beforeCommit?(): Promise<void>;
  assertCurrent(state: RepositoryState): void;
  stage(stage: string): Promise<void>;
  read(name: string, args: Record<string, unknown>, dispatch: (beforeDispatch: (role: string) => Promise<void>) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>>;
  saved(state: RepositoryState, message: StoredRecord): void;
  artifact(state: RepositoryState, reference: { type: "workflow-draft" | "node-proposal" | "workflow-proposal"; id: string }): void;
};
export type StoredChatInput = { session: Record<string, unknown>; userMessage: StoredRecord; priorMessages: string[] };
