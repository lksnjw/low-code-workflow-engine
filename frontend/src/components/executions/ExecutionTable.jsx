import DataTable from "../shared/tables/DataTable";
import ExecutionStatus from "./ExecutionStatus";
import { Link } from "react-router-dom";

const columns = [
  { key: "id", label: "Run ID" },
  { key: "workflow", label: "Workflow" },
  { key: "status", label: "Status" },
  { key: "duration", label: "Duration" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
];

/*******************************************************************************
 * Function: ExecutionTable
 *
 * Performs the Execution Table operation on table for the ExecutionTable module.
 ******************************************************************************/
function ExecutionTable({ executions }) {
  return (
    <DataTable
      columns={columns}
      rows={executions}
      renderCell={(run, column) => {
        if (column.key === "status") {
          return <ExecutionStatus status={run.status} failure={run.failure} />;
        }
        if (column.key === "id") {
          return <Link className="font-bold text-primary hover:underline" to={`/executions/${encodeURIComponent(run.id)}`}>{run.id}</Link>;
        }
        return run[column.key];
      }}
    />
  );
}

export default ExecutionTable;
