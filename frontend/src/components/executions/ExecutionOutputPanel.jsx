import { useState } from "react";
import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";

const TRUNCATE_AT = 2000;

/*******************************************************************************
 * Function: format
 *
 * Formats the application for the ExecutionOutputPanel module.
 ******************************************************************************/
function format(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/*******************************************************************************
 * Function: OutputBlock
 *
 * Performs the Output Block operation on block for the ExecutionOutputPanel module.
 ******************************************************************************/
function OutputBlock({ value }) {
  const [expanded, setExpanded] = useState(false);
  const text = format(value);
  const isLong = text.length > TRUNCATE_AT;
  const shown = expanded || !isLong ? text : `${text.slice(0, TRUNCATE_AT)}…`;

  return (
    <div>
      <pre
        data-testid="output-block"
        className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl bg-backgroundLight px-4 py-3 font-mono text-xs leading-6 text-gray-800 dark:bg-darkBackgroundVery dark:text-gray-200"
      >
        {shown}
      </pre>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 text-xs font-bold text-primary hover:underline"
        >
          {expanded ? "Show less" : `View full output (${text.length.toLocaleString()} characters)`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Shows what the run produced. For a completed run the final output leads; for
 * a run that stopped part way the steps that did complete are still shown, so
 * partial results are never lost behind the failure message.
 */
/*******************************************************************************
 * Function: ExecutionOutputPanel
 *
 * Performs the Execution Output Panel operation on output panel for the ExecutionOutputPanel module.
 ******************************************************************************/
function ExecutionOutputPanel({ execution }) {
  if (!execution) return null;
  const { finalOutput, stepOutputs, status } = execution;
  const stepEntries = Object.entries(stepOutputs || {});
  const hasFinal = finalOutput !== null && finalOutput !== undefined;

  if (!hasFinal && stepEntries.length === 0) {
    return (
      <Card>
        <h2 className="section-title mb-3">Workflow output</h2>
        <p data-testid="no-output" className="text-sm text-gray-500">
          This run did not produce an output.
        </p>
      </Card>
    );
  }

  const failed = status === "FAILED";

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="section-title">Workflow output</h2>
        {failed ? (
          <span
            data-testid="partial-output-badge"
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
          >
            <Icon icon="mdi:progress-alert" className="h-4 w-4" />
            Partial — the run stopped early
          </span>
        ) : null}
      </div>

      {hasFinal ? (
        <div data-testid="final-output" className="mb-5">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">
            {failed ? "Last completed step" : "Final output"}
          </p>
          <OutputBlock value={finalOutput} />
        </div>
      ) : null}

      {stepEntries.length > 0 ? (
        <div data-testid="step-outputs">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Step outputs</p>
          <div className="space-y-3">
            {stepEntries.map(([stepId, value]) => (
              <div key={stepId}>
                <p className="mb-1 font-mono text-xs font-semibold text-gray-600 dark:text-gray-300">{stepId}</p>
                <OutputBlock value={value} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default ExecutionOutputPanel;
