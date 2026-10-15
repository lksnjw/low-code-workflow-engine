import { useState } from "react";
import { Icon } from "@iconify/react";
import ReadableValue from "./ReadableValue";
import { BarChart, LineChart, PieChart, ChartFrame, ChartTable } from "./ChatCharts";

function InlineBarChart({ vis }) {
  return <BarChart vis={vis} />;
}

function InlineLineChart({ vis }) {
  return <LineChart vis={vis} />;
}

function InlinePieChart({ vis }) {
  return <PieChart vis={vis} />;
}

function InlineVisTable({ vis }) {
  return <ChartFrame vis={vis}><ChartTable vis={vis} /></ChartFrame>;
}

export function InlineVisualisation({ vis }) {
  if (!vis) return null;
  if (!["bar", "line", "pie", "table"].includes(vis.type) || typeof vis.title !== "string" || !Array.isArray(vis.data) ||
      vis.data.some(item => !item || typeof item.label !== "string" || typeof item.value !== "number" || !Number.isFinite(item.value)))
    return <p role="status" className="mt-3 text-xs text-gray-500">Chart data cannot be displayed. Valid labels and finite numeric values are required.</p>;
  if (!vis.data.length) return <p role="status" className="mt-3 text-xs text-gray-500">No chart data is available.</p>;
  if (vis.type === "line") return <InlineLineChart vis={vis} />;
  if (vis.type === "pie") return <InlinePieChart vis={vis} />;
  if (vis.type === "table") return <InlineVisTable vis={vis} />;
  return <InlineBarChart vis={vis} />;
}

export function InlineSources({ sources, boundHit }) {
  const [open, setOpen] = useState(false);
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return (
    <div className="mt-2 rounded-xl border border-blue-100 dark:border-blue-900/40">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Icon icon="mdi:api" className="h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span className="flex-1 text-xs font-semibold text-blue-700 dark:text-blue-300">
          {sources.length} tool call{sources.length !== 1 ? "s" : ""}
          {boundHit ? " · preparation incomplete" : ""}
        </span>
        <Icon icon={open ? "mdi:chevron-up" : "mdi:chevron-down"} className="h-3.5 w-3.5 text-gray-400" />
      </button>
      {open && (
        <div className="border-t border-blue-100 px-3 pb-2 pt-1.5 dark:border-blue-900/40">
          <div className="space-y-1">
            {sources.map((call, index) => (
              <div key={index} className="space-y-2 border-b border-gray-100 py-2 text-[11px] last:border-0 dark:border-gray-800">
                <Icon icon="mdi:function-variant" className="h-3 w-3 shrink-0 text-blue-400" />
                <code className="font-mono text-blue-700 dark:text-blue-300">{call.name}</code>
                {call.arguments && Object.keys(call.arguments).length > 0 && <ReadableValue value={call.arguments} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
