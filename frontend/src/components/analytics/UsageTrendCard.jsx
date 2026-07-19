import MetricCard from "./MetricCard";

function UsageTrendCard({ summary = {} }) {
  const cost = Number(summary.tokenCostUsd || 0);
  return <MetricCard label="Measured Token Cost" value={`$${cost.toFixed(2)}`} detail="Only provider usage recorded by executions is included." />;
}

export default UsageTrendCard;
