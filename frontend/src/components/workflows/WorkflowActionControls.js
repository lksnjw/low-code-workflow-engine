import React from "react";

export default function WorkflowActionControls({ canRun, canExport, running, onRun, onExport }) {
  return React.createElement(
    "div",
    { className: "flex flex-wrap gap-3" },
    canRun
      ? React.createElement(
          "button",
          {
            type: "button",
            onClick: onRun,
            disabled: running,
            className: "inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-60",
          },
          running ? "Running…" : "Run"
        )
      : null,
    canExport
      ? React.createElement(
          "button",
          {
            type: "button",
            onClick: onExport,
            className: "inline-flex items-center justify-center rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-darkBackground dark:text-gray-200",
          },
          "Export YAML"
        )
      : null
  );
}
