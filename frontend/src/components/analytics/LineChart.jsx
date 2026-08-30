import Card from "../shared/ui/Card";

/*******************************************************************************
 * Function: LineChart
 *
 * Performs the Line Chart operation on chart for the LineChart module.
 ******************************************************************************/
function LineChart({ data = [] }) {
/*******************************************************************************
 * Function: max
 *
 * Performs the max operation on the application for the LineChart module.
 ******************************************************************************/
  const max = Math.max(1, ...data.map((item) => Number(item.costUsd || 0)));
  const step = data.length > 1 ? 460 / (data.length - 1) : 0;
/*******************************************************************************
 * Function: points
 *
 * Performs the points operation on the application for the LineChart module.
 ******************************************************************************/
  const points = data.map((item, index) => `${index * step + 20},${180 - (Number(item.costUsd || 0) / max) * 140}`).join(" ");
  return (
    <Card><h2 className="section-title">Cost Trend</h2><p className="section-subtitle mt-1">Measured provider spend from executions.</p>
      {data.length === 0 ? <p className="mt-8 text-sm text-gray-500">No measured cost data available.</p> : <svg viewBox="0 0 500 210" className="mt-5 h-52 w-full overflow-visible"><polyline fill="none" stroke="#84006A" strokeWidth="5" strokeLinecap="round" points={points} />{data.map((item, index) => <circle key={item.label} cx={index * step + 20} cy={180 - (Number(item.costUsd || 0) / max) * 140} r="5" fill="#84006A" />)}</svg>}
    </Card>
  );
}

export default LineChart;
