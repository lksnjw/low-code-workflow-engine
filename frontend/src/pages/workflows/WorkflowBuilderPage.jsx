import WorkflowBuilderCanvas from "../../components/canvas/WorkflowBuilderCanvas";
import { useRoute } from "../../context/RouteContext";
import usePermissions from "../../hooks/usePermissions";

function WorkflowBuilderPage() {
  const { selectedWorkflowId } = useRoute();
  const { has } = usePermissions();
  return <WorkflowBuilderCanvas workflowId={selectedWorkflowId} readOnly={!has("workflow:write")} />;
}

export default WorkflowBuilderPage;
