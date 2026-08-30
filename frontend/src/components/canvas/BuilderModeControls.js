import React from "react";

/*******************************************************************************
 * Function: BuilderModeControls
 *
 * Performs the Builder Mode Controls operation on mode controls for the BuilderModeControls module.
 ******************************************************************************/
export default function BuilderModeControls({ isExecuting, onDeploy, onRun }) {
  return React.createElement(
    "div",
    { className: "flex items-center gap-3" },
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onDeploy,
        className: "inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50",
      },
      "Deploy Workflow"
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onRun,
        disabled: isExecuting,
        className: "inline-flex h-10 items-center rounded-lg bg-slate-950 px-4 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
      },
      isExecuting ? "Running…" : "Run Workflow"
    )
  );
}
