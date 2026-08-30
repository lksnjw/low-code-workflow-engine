import Card from "../shared/ui/Card";

/*******************************************************************************
 * Function: BarChart
 *
 * Performs the Bar Chart operation on chart for the BarChart module.
 ******************************************************************************/
function BarChart({ data = [] }) {
/*******************************************************************************
 * Function: max
 *
 * Performs the max operation on the application for the BarChart module.
 ******************************************************************************/
  const max = Math.max(1, ...data.map((item) => item.runs || 0));
  return (
    <Card className="lg:col-span-2">
      <h2 className="section-title">Run Volume</h2><p className="section-subtitle mt-1">Recorded workflow executions by day.</p>
      {data.length === 0 ? <p className="mt-8 text-sm text-gray-500">No execution data available.</p> : (
        <div className="mt-6 flex h-64 items-end gap-3">{data.map((item) => <div key={item.label} className="flex flex-1 flex-col items-center gap-2"><div className="w-full rounded-t-xl bg-primary" style={{ height: `${Math.max(2, ((item.runs || 0) / max) * 100)}%` }} title={`${item.runs || 0} runs`} /><span className="text-xs font-semibold text-gray-500">{item.label.slice(5)}</span></div>)}</div>
      )}
    </Card>
  );
}

export default BarChart;
