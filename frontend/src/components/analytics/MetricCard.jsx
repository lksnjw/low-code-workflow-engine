import Card from "../shared/ui/Card";

/*******************************************************************************
 * Function: MetricCard
 *
 * Performs the Metric Card operation on card for the MetricCard module.
 ******************************************************************************/
function MetricCard({ label, value, detail }) {
  return (
    <Card>
      <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">{label}</p>
      <p className="metric-number mt-4 text-gray-950 dark:text-white">{value}</p>
      <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{detail}</p>
    </Card>
  );
}

export default MetricCard;
