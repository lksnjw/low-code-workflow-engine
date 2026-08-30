import { Icon } from "@iconify/react";
import { FAILURE_CATEGORY, isGovernanceBlock } from "../../constants/workflowStatus";

/*******************************************************************************
 * Function: Field
 *
 * Performs the Field operation on the application for the GovernanceBlockPanel module.
 ******************************************************************************/
function Field({ label, value, mono }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300/80">{label}</dt>
      <dd className={`mt-1 text-sm text-amber-950 dark:text-amber-100 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/**
 * Explains a governance block. A policy violation is decided immediately before
 * dispatch, so this is deliberately NOT the tool-failure red: nothing crashed,
 * the gate refused to let the call happen.
 */
/*******************************************************************************
 * Function: GovernanceBlockPanel
 *
 * Performs the Governance Block Panel operation on block panel for the GovernanceBlockPanel module.
 ******************************************************************************/
function GovernanceBlockPanel({ failure }) {
  if (!failure) return null;

  if (!isGovernanceBlock(failure)) {
    const validation = failure.failureCategory === FAILURE_CATEGORY.VALIDATION_FAILURE;
    const transient = failure.failureCategory === FAILURE_CATEGORY.TRANSIENT;
    const authDenied = failure.failureCategory === FAILURE_CATEGORY.AUTH_DENIED;
    const invalidRequest = failure.failureCategory === FAILURE_CATEGORY.INVALID_REQUEST;
    const notFound = failure.failureCategory === FAILURE_CATEGORY.NOT_FOUND;
    const title = validation
      ? "Execution stopped before dispatch"
      : transient
        ? "Transient ERP failure"
        : authDenied
          ? "ERP authorization denied"
          : invalidRequest
            ? "ERP request rejected"
            : notFound
              ? "ERP record not found"
              : "Tool failure";
    return (
      <section
        data-testid="tool-failure-panel"
        className="rounded-2xl border border-red-200 bg-red-50 p-5 dark:border-red-500/30 dark:bg-red-500/10"
      >
        <div className="flex items-center gap-2">
          <Icon icon="mdi:alert-circle-outline" className="h-5 w-5 text-red-600 dark:text-red-300" />
          <h2 className="text-base font-bold text-red-900 dark:text-red-200">
            {title}
          </h2>
        </div>
        <p className="mt-2 text-sm text-red-800 dark:text-red-200/90">
          {validation
            ? "This run stopped before any tool was reached."
            : `Step ${failure.failedStepId || "—"} failed while running ${failure.failedToolName || "the tool"}.`}
        </p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-red-700 dark:text-red-300/80">Step</dt>
            <dd className="mt-1 font-mono text-sm text-red-950 dark:text-red-100">{failure.failedStepId || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-red-700 dark:text-red-300/80">Tool</dt>
            <dd className="mt-1 font-mono text-sm text-red-950 dark:text-red-100">{failure.failedToolName || "—"}</dd>
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section
      data-testid="governance-block-panel"
      className="rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      <div className="flex items-center gap-2">
        <Icon icon="mdi:shield-alert-outline" className="h-5 w-5 text-amber-600 dark:text-amber-300" />
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
          Governance block
        </p>
      </div>
      <h2 className="mt-2 text-lg font-bold text-amber-950 dark:text-amber-100">
        Blocked by policy before the tool was called
      </h2>
      <p className="mt-2 text-sm leading-6 text-amber-900 dark:text-amber-100/90">
        This step did not fail. The validation gate evaluated the resolved parameter value at dispatch
        time and refused to let the call proceed.
      </p>

      <dl className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Rule" value={failure.ruleId} mono />
        <Field label="Blocked parameter" value={failure.blockedParameter} mono />
        <Field label="Step" value={failure.failedStepId} mono />
        <Field label="Tool" value={failure.failedToolName} mono />
      </dl>

      {failure.ruleMessage ? (
        <p className="mt-5 rounded-xl bg-amber-100/70 px-4 py-3 text-sm font-medium text-amber-950 dark:bg-amber-500/10 dark:text-amber-100">
          {failure.ruleMessage}
        </p>
      ) : null}

      {failure.toolWasCalled === false ? (
        <p
          data-testid="tool-not-called"
          className="mt-4 flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200"
        >
          <Icon icon="mdi:cancel" className="h-4 w-4" />
          The tool was never called. No external system was contacted.
        </p>
      ) : null}
    </section>
  );
}

export default GovernanceBlockPanel;
