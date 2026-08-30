import MetricCard from "./MetricCard";

/*******************************************************************************
 * Function: UsageTrendCard
 *
 * Performs the Usage Trend Card operation on trend card for the UsageTrendCard module.
 ******************************************************************************/
function UsageTrendCard({ summary = {} }) {
  const cost = Number(summary.tokenCostUsd || 0);
  return <MetricCard label="Measured Token Cost" value={`$${cost.toFixed(2)}`} detail="Only provider usage recorded by executions is included." />;
}

export default UsageTrendCard;
