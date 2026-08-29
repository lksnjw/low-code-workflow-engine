import { useState } from "react";

function TraceIdentifier({ traceId }) {
  const [copied, setCopied] = useState(false);
  if (!traceId) return null;

  const copy = async () => {
    await navigator.clipboard?.writeText(traceId);
    setCopied(true);
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
      <span>Trace</span>
      <code className="break-all rounded bg-gray-100 px-2 py-1 dark:bg-gray-800">
        {traceId}
      </code>
      <button
        type="button"
        onClick={copy}
        className="font-semibold text-primary hover:underline"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default TraceIdentifier;
