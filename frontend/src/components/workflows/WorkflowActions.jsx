import { useState } from "react";
import { Icon } from "@iconify/react";
import Button from "../shared/ui/Button";
import { useNotifications } from "../../context/NotificationContext";
import { workflowService } from "../../services/workflow.service";
import { apiErrorMessage } from "../../services/api";

function WorkflowActions({ workflow, onChanged }) {
  const { notify } = useNotifications();
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

  return (
    <div className="flex flex-wrap gap-3">
      <Button onClick={run} disabled={running}><Icon icon="mdi:play" className="h-5 w-5" />{running ? "Running…" : "Run"}</Button>
      <Button variant="secondary" onClick={exportYAML}><Icon icon="mdi:file-export-outline" className="h-5 w-5" />Export YAML</Button>
    </div>
  );
}

export default WorkflowActions;
