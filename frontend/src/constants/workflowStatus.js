export const WORKFLOW_STATUS = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  DONE: "DONE",
  FAILED: "FAILED",
  HEALING: "HEALING",
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
  "draft-unvalidated": {
    label: "Unvalidated draft",
    tone: "gray",
    color: "bg-gray-100 text-gray-700 dark:bg-gray-500/15 dark:text-gray-300",
  },
};
