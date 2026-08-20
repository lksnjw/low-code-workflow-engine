import { useState } from "react";
import Button from "../shared/ui/Button";
import Modal from "../shared/ui/Modal";
import Textarea from "../shared/ui/Textarea";
import { useNotifications } from "../../context/NotificationContext";
import { executionService } from "../../services/execution.service";
import { workflowService } from "../../services/workflow.service";
import { apiErrorDetails, apiErrorMessage } from "../../services/api";
import usePermissions from "../../hooks/usePermissions";
import WorkflowActionControls from "./WorkflowActionControls";
import GateRejectionAlert from "./GateRejectionAlert";

function WorkflowActions({ workflow, onChanged }) {
  const { notify } = useNotifications();
  const { has, hasAny } = usePermissions();
  const [running, setRunning] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runtimeInput, setRuntimeInput] = useState("{}");
  const [inputError, setInputError] = useState("");
  const [runError, setRunError] = useState(null);

  const openRunDialog = () => {
    setInputError("");
    setRunError(null);
    setRunDialogOpen(true);
  };

  const run = async (event) => {
    event?.preventDefault();
    let input;
    try {
      input = JSON.parse(runtimeInput);
    } catch {
      setInputError("The workflow input is not valid JSON. Enter a JSON object and try again.");
      return;
    }
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      setInputError("Runtime input must be a JSON object.");
      return;
    }
    setInputError("");
    setRunError(null);

    setRunning(true);
    try {
      const execution = await executionService.run(workflow.id, input);
      setRunDialogOpen(false);
      notify(`Execution ${execution.id} finished with status ${execution.status}.`, execution.status === "DONE" ? "success" : "warning");
      await onChanged?.();
    } catch (error) {
      const details = apiErrorDetails(error, "Workflow run failed.");
      setRunError(details);
      notify(details.message, "error");
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
    <>
      <WorkflowActionControls
        canRun={hasAny(["workflow:run", "workflow:run_own"])}
        canExport={has("workflow:write")}
        running={running}
        onRun={openRunDialog}
        onExport={exportYAML}
      />
      <Modal open={runDialogOpen} title="Run workflow">
        <form className="space-y-4" onSubmit={run}>
          <div>
            <label
              className="text-sm font-semibold text-gray-800 dark:text-gray-100"
              htmlFor={`workflow-runtime-input-${workflow.id}`}
            >
              Runtime input (JSON)
            </label>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
              Values here replace workflow expressions such as {"{{input.message}}"}. Use an empty object when no input is required.
            </p>
          </div>
          <Textarea
            id={`workflow-runtime-input-${workflow.id}`}
            aria-invalid={Boolean(inputError)}
            className="min-h-40 font-mono text-xs leading-6"
            spellCheck="false"
            value={runtimeInput}
            onChange={(event) => {
              setRuntimeInput(event.target.value);
              setInputError("");
            }}
          />
          {inputError ? <p className="text-sm font-semibold text-red-600" role="alert">{inputError}</p> : null}
          <GateRejectionAlert details={runError} />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setRunDialogOpen(false)}
              disabled={running}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={running}>
              {running ? "Running…" : "Run workflow"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export default WorkflowActions;
