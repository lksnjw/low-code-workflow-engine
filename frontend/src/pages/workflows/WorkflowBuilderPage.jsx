import WorkflowBuilderCanvas from "../../components/canvas/WorkflowBuilderCanvas";
import { useRoute } from "../../context/RouteContext";

/*******************************************************************************
 * Function: WorkflowBuilderPage
 *
 * Performs the Workflow Builder Page operation on builder page for the WorkflowBuilderPage module.
 ******************************************************************************/
function WorkflowBuilderPage() {
  const { selectedWorkflowId } = useRoute();
  return <WorkflowBuilderCanvas workflowId={selectedWorkflowId} readOnly />;
}

export default WorkflowBuilderPage;
