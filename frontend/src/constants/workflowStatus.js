export const WORKFLOW_STATUS = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  DONE: "DONE",
  FAILED: "FAILED",
  HEALING: "HEALING",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  DRAFT_UNVALIDATED: "draft-unvalidated",
};

export const STATUS_META = {
  PENDING: {
    label: "Pending",
    tone: "amber",
    color: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
  RUNNING: {
    label: "Running",
    tone: "blue",
    color: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  },
  DONE: {
    label: "Done",
    tone: "green",
    color: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  },
  FAILED: {
    label: "Failed",
    tone: "red",
    color: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  },
  HEALING: {
    label: "Healing",
    tone: "purple",
    color: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300",
  },
  AWAITING_APPROVAL: {
    label: "Awaiting approval",
    tone: "amber",
    color: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  },
  "draft-unvalidated": {
    label: "Unvalidated draft",
    tone: "gray",
    color: "bg-gray-100 text-gray-700 dark:bg-gray-500/15 dark:text-gray-300",
  },
};

export const FAILURE_CATEGORY = {
  POLICY_VIOLATION: "POLICY_VIOLATION",
  TOOL_FAILURE: "TOOL_FAILURE",
  VALIDATION_FAILURE: "VALIDATION_FAILURE",
  INVALID_REQUEST: "INVALID_REQUEST",
  AUTH_DENIED: "AUTH_DENIED",
  NOT_FOUND: "NOT_FOUND",
  TRANSIENT: "TRANSIENT",
};

// A governance block and a tool failure are both status FAILED. The failure
// classification is what decides how the run is presented, so a policy block
// never wears the tool-failure red.
export const BLOCKED_META = {
  label: "Blocked",
  tone: "amber",
  color: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
};

/*******************************************************************************
 * Function: isGovernanceBlock
 *
 * Determines whether governance block for the workflowStatus module.
 ******************************************************************************/
export function isGovernanceBlock(failure) {
  return failure?.failureCategory === FAILURE_CATEGORY.POLICY_VIOLATION;
}

/*******************************************************************************
 * Function: statusMetaFor
 *
 * Performs the status Meta For operation on meta for for the workflowStatus module.
 ******************************************************************************/
export function statusMetaFor(status, failure) {
  if (status === WORKFLOW_STATUS.FAILED && isGovernanceBlock(failure)) return BLOCKED_META;
  return STATUS_META[status] ?? {
    label: typeof status === "string" && status ? status : "Unknown",
    tone: "gray",
    color: "bg-gray-100 text-gray-700 dark:bg-gray-500/15 dark:text-gray-300",
  };
}
