import Card from "../shared/ui/Card";

function F1ScoreGauge({ data = {} }) {
  const available = data.available !== false && data.score != null;
  return <Card><h2 className="section-title">Validation F1</h2><div className="mt-5 flex items-center gap-4"><div className="flex h-28 w-28 items-center justify-center rounded-full border-[12px] border-primary text-2xl font-bold text-gray-950 dark:text-white">{available ? Number(data.score).toFixed(2) : "N/A"}</div><p className="text-sm leading-6 text-gray-500 dark:text-gray-400">{available ? `${data.samples || 0} recorded validation samples.` : "No runtime validation benchmark has been recorded."}</p></div></Card>;
}

export default F1ScoreGauge;
