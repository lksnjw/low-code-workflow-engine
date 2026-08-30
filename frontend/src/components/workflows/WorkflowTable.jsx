import DataTable from "../shared/tables/DataTable";
import WorkflowBadge from "./WorkflowBadge";

const columns = [
  { key: "name", label: "Workflow" },
  { key: "owner", label: "Owner" },
  { key: "trigger", label: "Trigger" },
  { key: "domainTags", label: "Domains" },
  { key: "canRun", label: "Access" },
  { key: "successRate", label: "Success" },
  { key: "status", label: "Status" },
];

/*******************************************************************************
 * Function: WorkflowTable
 *
 * Performs the Workflow Table operation on table for the WorkflowTable module.
 ******************************************************************************/
function WorkflowTable({ workflows, onOpen }) {
  return (
    <DataTable
      columns={columns}
      rows={workflows}
      renderCell={(workflow, column) => {
        if (column.key === "status") {
          return <WorkflowBadge status={workflow.status} />;
        }
        if (column.key === "name") {
          return (
            <button type="button" className="text-left" onClick={() => onOpen?.(workflow.id)}>
              <p className="font-bold text-gray-950 dark:text-white">{workflow.name}</p>
              <p className="mt-1 text-xs text-gray-500">{workflow.id}</p>
            </button>
          );
        }
        if (column.key === "domainTags") {
          return (workflow.domainTags || []).join(", ") || "—";
        }
        if (column.key === "canRun") {
          return workflow.canRun ? "You can run this" : "View only";
        }
        return workflow[column.key];
      }}
    />
  );
}

export default WorkflowTable;
