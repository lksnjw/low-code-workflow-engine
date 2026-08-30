import Card from "../shared/ui/Card";

/*******************************************************************************
 * Function: logLine
 *
 * Performs the log Line operation on line for the LiveLogStream module.
 ******************************************************************************/
function logLine(log) {
  const timestamp = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : "--:--:--";
  return `[${timestamp}] ${log.level || "info"} ${log.nodeId || "system"} ${log.message || ""}`;
}

/*******************************************************************************
 * Function: LiveLogStream
 *
 * Performs the Live Log Stream operation on log stream for the LiveLogStream module.
 ******************************************************************************/
function LiveLogStream({ logs = [], executionId }) {
  return (
    <Card className="bg-gray-950 text-gray-100 dark:bg-black">
      <div className="mb-4 flex items-center justify-between">
        <div><h2 className="text-base font-bold text-white">Execution Logs</h2><p className="mt-1 text-xs text-gray-400">{executionId}</p></div>
        <span className="rounded-full bg-blue-500/15 px-3 py-1 text-xs font-bold text-blue-300">recorded</span>
      </div>
      <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap text-xs leading-7 text-gray-300">
        {logs.length ? logs.map(logLine).join("\n") : "No logs were recorded for this execution."}
      </pre>
    </Card>
  );
}

export default LiveLogStream;
