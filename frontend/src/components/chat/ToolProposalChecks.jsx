export default function ToolProposalChecks({ corrections }) {
  if (!Array.isArray(corrections)) return null;
  const valid = corrections.filter(item => item?.status === "NOT_DISPATCHED" &&
    ["TOOL_NAME", "ARGUMENT_SCHEMA", "SCOPE_CHANGE"].includes(item.reason) && typeof item.correctionRequested === "boolean");
  if (!valid.length) return null;
  const stopped = valid.some(item => !item.correctionRequested);
  return <section aria-label="Tool input checks" className="mt-3 border-l-2 border-amber-400 pl-3 text-xs leading-5 text-gray-600 dark:text-gray-300">
    <p role="status" className="font-medium">{stopped ? "Tool input correction stopped" : "Tool input correction requested"}</p>
    <p>{valid.length} invalid proposal{valid.length === 1 ? " was" : "s were"} withheld before dispatch. {stopped ? "The assistant could not safely resolve the input within its correction limit." : "The workflow assistant checked the offered contract and requested a revised proposal."}</p>
    <p>These proposals were not sent to ERPBridge. Confirmed tool responses, not input corrections, show which reads completed. No email or ERP write is authorized by a correction.</p>
    <details className="mt-1"><summary className="cursor-pointer text-primary">View input checks</summary>
      <ul className="mt-1 space-y-1">{valid.slice(0, 32).map((item, index) => <li key={index}>
        {item.toolName || "Tool"} · {item.reason === "SCOPE_CHANGE" ? "Correction changed concrete values or scope" : item.reason === "TOOL_NAME" ? "Tool name did not match an offered contract" : "Payload did not match the input schema"} · Not dispatched
      </li>)}</ul>
    </details>
  </section>;
}
