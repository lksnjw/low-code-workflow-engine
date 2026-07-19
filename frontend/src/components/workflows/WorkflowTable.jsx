import DataTable from "../shared/tables/DataTable";
import WorkflowBadge from "./WorkflowBadge";

const columns = [
  { key: "name", label: "Workflow" },
  { key: "owner", label: "Owner" },
  { key: "trigger", label: "Trigger" },
  { key: "successRate", label: "Success" },
  { key: "status", label: "Status" },
];

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
        return workflow[column.key];
      }}
    />
  );
}

export default WorkflowTable;
