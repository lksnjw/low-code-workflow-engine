import { statusMetaFor } from "../../constants/workflowStatus";

function WorkflowBadge({ status }) {
  const meta = statusMetaFor(status);

  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${meta.color}`}>{meta.label}</span>;
}

export default WorkflowBadge;
