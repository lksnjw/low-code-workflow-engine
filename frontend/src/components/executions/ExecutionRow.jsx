import ExecutionStatus from "./ExecutionStatus";

function ExecutionRow({ run }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-backgroundLight p-3 dark:bg-darkBackgroundVery">
      <div>
        <p className="font-semibold text-gray-950 dark:text-white">{run.workflow}</p>
        <p className="text-xs text-gray-500">{run.id}</p>
      </div>
      <ExecutionStatus status={run.status} failure={run.failure} />
    </div>
  );
}

export default ExecutionRow;
