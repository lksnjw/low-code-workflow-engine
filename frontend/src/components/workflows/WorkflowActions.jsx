import { useState } from "react";
import { useNotifications } from "../../context/NotificationContext";
import { workflowService } from "../../services/workflow.service";
import { apiErrorMessage } from "../../services/api";
import usePermissions from "../../hooks/usePermissions";
import WorkflowActionControls from "./WorkflowActionControls";

function WorkflowActions({ workflow, onChanged }) {
  const { notify } = useNotifications();
  const { has, hasAny } = usePermissions();
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const execution = await workflowService.run(workflow.id, {});
      notify(`Execution ${execution.id} finished with status ${execution.status}.`, execution.status === "DONE" ? "success" : "warning");
      await onChanged?.();
    } catch (error) {
      notify(apiErrorMessage(error, "Workflow run failed."), "error");
    } finally {
      setRunning(false);
    }
  };

  const exportYAML = async () => {
    try {
      const record = await workflowService.getYAML(workflow.id);
      const url = URL.createObjectURL(new Blob([record.yaml], { type: "text/yaml" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${workflow.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || workflow.id}.yaml`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify(apiErrorMessage(error, "Could not export workflow YAML."), "error");
    }
  };

  return <WorkflowActionControls canRun={hasAny(["workflow:run", "workflow:run_own"])} canExport={has("workflow:write")} running={running} onRun={run} onExport={exportYAML} />;
}

export default WorkflowActions;
