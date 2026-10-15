import { useState } from "react";
import Button from "../shared/ui/Button";
import Modal from "../shared/ui/Modal";
import Textarea from "../shared/ui/Textarea";
import { useNotifications } from "../../context/NotificationContext";
import { useRoute } from "../../context/RouteContext";
import { executionService } from "../../services/execution.service";
import { workflowService } from "../../services/workflow.service";
import { apiErrorDetails, apiErrorMessage } from "../../services/api";
import usePermissions from "../../hooks/usePermissions";
import WorkflowActionControls from "./WorkflowActionControls";
import GateRejectionAlert from "./GateRejectionAlert";

/*******************************************************************************
 * Function: WorkflowActions
 *
 * Performs the Workflow Actions operation on actions for the WorkflowActions module.
 ******************************************************************************/
function WorkflowActions({ workflow, onChanged, showRun = true }) {
  const { notify } = useNotifications();
  const { navigateTo } = useRoute();
  const { has, hasAny } = usePermissions();
  const [running, setRunning] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runtimeInput, setRuntimeInput] = useState("{}");
  const [inputError, setInputError] = useState("");
  const [runError, setRunError] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

/*******************************************************************************
 * Function: openRunDialog
 *
 * Performs the open Run Dialog operation on run dialog for the WorkflowActions module.
 ******************************************************************************/
  const openRunDialog = () => {
    setInputError("");
    setRunError(null);
    setRunDialogOpen(true);
  };

/*******************************************************************************
 * Function: run
 *
 * Runs the application for the WorkflowActions module.
 ******************************************************************************/
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
      const terminal = ["DONE", "FAILED", "CANCELLED"].includes(execution.status);
      notify(terminal ? `Execution ${execution.id} finished with status ${execution.status}.`
        : `Execution ${execution.id} accepted with status ${execution.status}. Open Execution History to follow its progress.`, execution.status === "DONE" ? "success" : terminal ? "warning" : "info");
      // A list refresh cannot invalidate a known admission or imply a retry.
      try { await onChanged?.(); }
      catch { notify(`Execution ${execution.id} was recorded, but this list could not refresh. Open Execution History to review it.`, "warning"); }
    } catch (error) {
      const details = apiErrorDetails(error, "Workflow run failed.");
      setRunError(details);
      notify(details.message, "error");
    } finally {
      setRunning(false);
    }
  };

/*******************************************************************************
 * Function: exportYAML
 *
 * Exports yaml for the WorkflowActions module.
 ******************************************************************************/
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

/*******************************************************************************
 * Function: handleDelete
 *
 * Deletes the workflow after confirmation and returns to the workflow list.
 ******************************************************************************/
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await workflowService.remove(workflow.id);
      notify(`Workflow "${workflow.name}" deleted.`, "success");
      setDeleteDialogOpen(false);
      navigateTo("workflows", "list");
    } catch (error) {
      notify(apiErrorMessage(error, "Could not delete workflow."), "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <WorkflowActionControls
        canRun={showRun && hasAny(["workflow:run", "workflow:run_own"])}
        canExport={has("workflow:write")}
        canDelete={has("workflow:write")}
        running={running}
        deleting={deleting}
        onRun={openRunDialog}
        onExport={exportYAML}
        onDelete={() => setDeleteDialogOpen(true)}
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
      <Modal open={deleteDialogOpen} title="Delete workflow">
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Delete <span className="font-semibold text-gray-950 dark:text-white">{workflow.name}</span>? This permanently removes the workflow definition, its schedule, and its assignments. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete workflow"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export default WorkflowActions;
