import type { Execution } from "../repository/store.js";

export type ExecutionReader = {
  id: string;
  permissions: readonly string[];
};

export function canReadExecution(
  user: ExecutionReader,
  execution: Execution,
): boolean {
  return (
    user.permissions.includes("workflow:read") ||
    execution.startedBy.id === user.id
  );
}

export function visibleExecutions(
  user: ExecutionReader,
  executions: readonly Execution[],
): Execution[] {
  return executions.filter((execution) => canReadExecution(user, execution));
}
