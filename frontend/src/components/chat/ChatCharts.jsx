const COLORS = ["#b52a97", "#0284c7", "#d97706", "#059669", "#dc2626", "#db2777", "#6366f1", "#65a30d"];
const number = value => value.toLocaleString(undefined, { maximumFractionDigits: 4 });

export function ChartTable({ vis }) {
  return <div className="min-w-0 overflow-x-auto">
    <table className="w-full border-collapse text-xs">
      <caption className="sr-only">{vis.title} — data</caption>
      <thead><tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-700"><th scope="col" className="px-1 py-2 font-medium">Label</th><th scope="col" className="px-1 py-2 text-right font-medium">Value</th></tr></thead>
      <tbody>{vis.data.map((item, index) => <tr key={index} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
        <th scope="row" className="break-words px-1 py-2 text-left font-normal text-gray-700 dark:text-gray-300">{item.label}</th>
        <td className="whitespace-nowrap px-1 py-2 text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100">{number(item.value)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function ChartFrame({ vis, children }) {
  return <figure aria-label={`${vis.title} — ${vis.type} chart`} className="mt-3 min-w-0 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-darkBackground">
    <figcaption className="mb-3 break-words text-xs font-semibold leading-5 text-gray-800 dark:text-gray-200">{vis.title}</figcaption>
    {children}
    {vis.type !== "table" && <details className="mt-3 border-t border-gray-100 pt-2 text-xs text-gray-500 dark:border-gray-800">
      <summary className="cursor-pointer rounded py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">View chart data · {vis.data.length} {vis.data.length === 1 ? "row" : "rows"}</summary>
      <ChartTable vis={vis} />
    </details>}
  </figure>;
}

export function BarChart({ vis }) {
  const min = vis.data.reduce((value, item) => Math.min(value, item.value), 0);
  const max = vis.data.reduce((value, item) => Math.max(value, item.value), 0);
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const range = max / scale - min / scale || 1;
  return <ChartFrame vis={vis}>
    <div className="space-y-3">{vis.data.slice(0, 10).map((item, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 text-xs">
      <span className="break-words leading-5 text-gray-600 dark:text-gray-300">{item.label}</span>
      <span className="text-right font-semibold leading-5 tabular-nums text-gray-900 dark:text-gray-100">{number(item.value)}</span>
      <div aria-hidden="true" className="relative col-span-2 h-2 rounded-full bg-gray-100 dark:bg-gray-800">
        {min < 0 && <span className="absolute -top-1 h-4 w-px bg-gray-400" style={{ left: `${-min / scale / range * 100}%` }} />}
        <span className="absolute h-2 rounded-full bg-primary dark:bg-fuchsia-400" style={{ left: `${(Math.min(item.value, 0) / scale - min / scale) / range * 100}%`, width: `${Math.abs(item.value) / scale / range * 100}%` }} />
      </div>
    </div>)}</div>
    {vis.data.length > 10 && <p className="mt-3 text-[11px] text-gray-500">Showing the first 10 of {vis.data.length} bars. All values are available below.</p>}
  </ChartFrame>;
}

export function LineChart({ vis }) {
  const width = 400, height = 180, left = 48, right = 16, top = 18, bottom = 28;
  const max = vis.data.reduce((value, item) => Math.max(value, item.value), 0) || 1;
  const min = vis.data.reduce((value, item) => Math.min(value, item.value), 0);
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const range = max / scale - min / scale || 1;
  const points = vis.data.map((item, index) => ({ ...item,
    x: vis.data.length === 1 ? (left + width - right) / 2 : left + index * (width - left - right) / (vis.data.length - 1),
    y: height - bottom - (item.value / scale - min / scale) / range * (height - top - bottom),
  }));
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  return <ChartFrame vis={vis}>
    <svg role="img" aria-label={`${vis.title} — line plot`} viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible" style={{ maxHeight: 220 }}>
      <title>{vis.title}</title><desc>{vis.data.map(item => `${item.label}: ${item.value}`).join("; ")}</desc>
      {[max, max / 2 + min / 2, min].map((value, index) => {
        const y = top + index * (height - top - bottom) / 2;
        return <g key={index}><line x1={left} x2={width - right} y1={y} y2={y} className="stroke-gray-200 dark:stroke-gray-700" strokeDasharray="3 3" /><text x={left - 8} y={y + 3} textAnchor="end" fontSize="10" className="fill-gray-500 dark:fill-gray-400">{number(value)}</text></g>;
      })}
      <path d={path} fill="none" className="stroke-primary dark:stroke-fuchsia-400" strokeWidth="2.5" strokeLinejoin="round" />
      {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="3.5" className="fill-primary dark:fill-fuchsia-400"><title>{point.label}: {number(point.value)}</title></circle>)}
    </svg>
    <div className="flex justify-between gap-3 text-[10px] text-gray-500"><span className="min-w-0 break-words">{points[0].label}</span>{points.length > 1 && <span className="min-w-0 break-words text-right">{points[points.length - 1].label}</span>}</div>
    {points.length === 1 && <p className="mt-2 text-[11px] text-gray-500">One data point — no trend can be established.</p>}
  </ChartFrame>;
}

export function PieChart({ vis }) {
  const total = vis.data.reduce((sum, item) => sum + item.value, 0);
  if (vis.data.some(item => item.value < 0) || !Number.isFinite(total) || total <= 0) return <ChartFrame vis={vis}><p className="text-xs leading-5 text-gray-500">A pie chart needs non-negative values with a positive total. The supplied values are available below.</p></ChartFrame>;
  const segments = vis.data.reduce((items, item, index) => {
    const start = items.length ? items[items.length - 1].end : 0;
    items.push({ ...item, color: COLORS[index % COLORS.length], start, end: start + item.value / total * 360 });
    return items;
  }, []);
  return <ChartFrame vis={vis}>
    <div className="flex flex-wrap items-center gap-4">
      <div role="img" aria-label={`${vis.title} — pie plot, total ${number(total)}`} className="h-28 w-28 shrink-0 rounded-full" style={{ background: `conic-gradient(${segments.map(segment => `${segment.color} ${segment.start}deg ${segment.end}deg`).join(", ")})` }} />
      <ul className="min-w-[140px] flex-1 space-y-2">{segments.map((item, index) => <li key={index} className="flex items-start gap-2 text-xs">
        <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
        <span className="min-w-0 flex-1 break-words text-gray-600 dark:text-gray-300">{item.label}</span>
        <span className="shrink-0 text-right font-semibold tabular-nums text-gray-800 dark:text-gray-100">{number(item.value)}<span className="block text-[10px] font-normal text-gray-500">{(item.value / total * 100).toFixed(1)}%</span></span>
      </li>)}</ul>
    </div>
    <p className="mt-3 text-xs text-gray-500">Total <span className="font-semibold tabular-nums text-gray-800 dark:text-gray-100">{number(total)}</span></p>
  </ChartFrame>;
}
