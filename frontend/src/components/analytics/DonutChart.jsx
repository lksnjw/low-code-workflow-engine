import Card from "../shared/ui/Card";

function DonutChart({ successRate = 0 }) {
  const rate = Math.max(0, Math.min(100, Number(successRate || 0)));
  return <Card><h2 className="section-title">Status Breakdown</h2><div className="mt-6 flex items-center justify-center"><div className="h-44 w-44 rounded-full" style={{ background: `conic-gradient(#16A34A 0 ${rate}%, #DC2626 ${rate}% 100%)` }}><div className="m-6 flex h-32 w-32 flex-col items-center justify-center rounded-full bg-white dark:bg-darkBackground"><span className="text-2xl font-bold text-gray-950 dark:text-white">{rate.toFixed(1)}%</span><span className="text-xs font-semibold text-gray-500">success</span></div></div></div></Card>;
}

export default DonutChart;
