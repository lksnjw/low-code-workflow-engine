import { statusMetaFor } from "../../constants/workflowStatus";

/*******************************************************************************
 * Function: WorkflowBadge
 *
 * Performs the Workflow Badge operation on badge for the WorkflowBadge module.
 ******************************************************************************/
function WorkflowBadge({ status }) {
  const meta = statusMetaFor(status);

  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${meta.color}`}>{meta.label}</span>;
}

export default WorkflowBadge;
