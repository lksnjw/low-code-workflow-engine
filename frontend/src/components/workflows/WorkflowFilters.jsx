import { Icon } from "@iconify/react";
import Input from "../shared/ui/Input";
import Select from "../shared/ui/Select";

/*******************************************************************************
 * Function: WorkflowFilters
 *
 * Performs the Workflow Filters operation on filters for the WorkflowFilters module.
 ******************************************************************************/
function WorkflowFilters({ query, status, onQueryChange, onStatusChange }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <label className="relative min-w-0 flex-1 md:max-w-md">
        <Icon
          icon="mdi:magnify"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
        />
        <Input className="pl-9" placeholder="Search workflows..." value={query} onChange={(event) => onQueryChange(event.target.value)} />
      </label>
      <div className="flex gap-2">
        <Select value={status} onChange={(event) => onStatusChange(event.target.value)}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="DONE">Published</option>
          <option value="draft-unvalidated">Unvalidated draft</option>
        </Select>
      </div>
    </div>
  );
}

export default WorkflowFilters;
