import React from "react";

export default function BuilderModeControls({ readOnly, isExecuting, onDeploy, onRun }) {
  if (readOnly) {
    return React.createElement(
      "span",
      { className: "rounded-full border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600" },
      "Read-only preview"
    );
  }

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
