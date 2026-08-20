import { Icon } from "@iconify/react";
import { isGovernanceBlock, statusMetaFor } from "../../constants/workflowStatus";

const icons = {
  RUNNING: "mdi:play-circle-outline",
  DONE: "mdi:check-circle-outline",
  FAILED: "mdi:alert-circle-outline",
  HEALING: "mdi:shield-refresh-outline",
  PENDING: "mdi:clock-outline",
};

function ExecutionStatus({ status, failure }) {
  const blocked = isGovernanceBlock(failure);
  const meta = statusMetaFor(status, failure);
  const icon = blocked ? "mdi:shield-alert-outline" : icons[status] ?? "mdi:help-circle-outline";

  return (
    <span
      data-testid="execution-status"
      data-blocked={blocked ? "true" : "false"}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${meta.color}`}
    >
      <Icon icon={icon} className="h-4 w-4" />
      {meta.label}
    </span>
  );
}

export default ExecutionStatus;
