import Input from "../shared/ui/Input";
import Select from "../shared/ui/Select";

/*******************************************************************************
 * Function: ExecutionFilters
 *
 * Performs the Execution Filters operation on filters for the ExecutionFilters module.
 ******************************************************************************/
function ExecutionFilters({ query, status, range, onQueryChange, onStatusChange, onRangeChange }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <Input className="md:max-w-md" placeholder="Search run id or workflow..." value={query} onChange={(event) => onQueryChange(event.target.value)} />
      <div className="flex gap-2">
        <Select value={range} onChange={(event) => onRangeChange(event.target.value)}>
          <option value="">All time</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
        <Select value={status} onChange={(event) => onStatusChange(event.target.value)}>
          <option value="">All statuses</option>
          <option value="DONE">Completed</option>
          <option value="FAILED">Failed</option>
          <option value="HEALING">Healing</option>
          <option value="RUNNING">Running</option>
        </Select>
      </div>
    </div>
  );
}

export default ExecutionFilters;
