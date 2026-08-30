import Card from "../shared/ui/Card";

/*******************************************************************************
 * Function: HeatmapCalendar
 *
 * Performs the Heatmap Calendar operation on calendar for the HeatmapCalendar module.
 ******************************************************************************/
function HeatmapCalendar({ data = [] }) {
  return <Card><h2 className="section-title">Activity Heatmap</h2>{data.length === 0 ? <p className="mt-8 text-sm text-gray-500">No activity data available.</p> : <div className="mt-5 grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(14, data.length)}, minmax(0, 1fr))` }}>{data.map((day) => <span key={day.date} className="aspect-square rounded bg-primary" title={`${day.date}: ${day.count} runs`} style={{ opacity: 0.12 + Number(day.intensity || 0) * 0.88 }} />)}</div>}</Card>;
}

export default HeatmapCalendar;
