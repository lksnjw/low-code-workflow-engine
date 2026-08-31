import type { Execution } from "../repository/store.js";

export type ExecutionReader = {
  id: string;
  permissions: readonly string[];
};

/*******************************************************************************
 * Function: canReadExecution
 *
 * Checks whether the user has permission to read an execution.
 ******************************************************************************/
export function canReadExecution(
  user: ExecutionReader,
  execution: Execution,
): boolean {
  return (
    user.permissions.includes("workflow:read") ||
    execution.startedBy.id === user.id
  );
}

/*******************************************************************************
 * Function: visibleExecutions
 *
 * Filters executions to those the current user can read.
 ******************************************************************************/
export function visibleExecutions(
  user: ExecutionReader,
  executions: readonly Execution[],
): Execution[] {
  return executions.filter((execution) => canReadExecution(user, execution));
}
