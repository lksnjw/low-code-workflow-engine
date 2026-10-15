import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { InlineVisualisation } from "../../components/chat/ChatMessageVisualisation";
import "../../styles/globals.css";

// Developer-only Vite fixture: actual chat renderers, no API or model calls.
const departments = [{ label: "Procurement and supplier management", value: 12 }, { label: "Finance", value: 8 }, { label: "Operations", value: 5 }, { label: "Human resources", value: 3 }];
const samples = [
  { type: "bar", title: "Requests by department", data: departments },
  { type: "line", title: "Requests over five days", data: [4, 6, 3, 8, 5].map((value, index) => ({ label: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][index], value })) },
  { type: "pie", title: "Request status", data: [{ label: "Approved", value: 14 }, { label: "Pending", value: 6 }, { label: "Rejected", value: 2 }] },
  { type: "table", title: "Department totals", data: departments },
];
function ChartPreview() {
  const [width, setWidth] = useState("full"), [dark, setDark] = useState(false);
  return <div className={dark ? "dark" : ""}><main className="min-h-screen bg-gray-50 px-6 py-8 text-gray-900 dark:bg-darkBackgroundVery dark:text-gray-100">
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-xl font-semibold">Chat chart presentation check</h1><p className="mt-2 text-sm text-gray-500">UI test data only — not ERP results. These are the same components used inside chat.</p></div>
        <div className="flex flex-wrap items-center gap-3"><label className="text-xs">Panel width <select aria-label="Preview panel width" value={width} onChange={event => setWidth(event.target.value)} className="ml-2 rounded border border-gray-300 bg-white p-2 text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"><option value="full">Full width</option><option value="440">440 px · floating chat</option><option value="320">320 px · minimum split pane</option></select></label><button type="button" onClick={() => setDark(value => !value)} aria-pressed={dark} className="rounded border border-gray-300 px-3 py-2 text-xs dark:border-gray-700">Dark preview</button></div>
      </header>
      <div className="grid items-start gap-6 md:grid-cols-2">{samples.map(sample => <section key={sample.type} aria-label={`${sample.type} preview`} className="min-w-0" style={{ maxWidth: width === "full" ? "100%" : `${width}px` }}>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{sample.type === "table" ? "Data table" : `${sample.type} chart`}</p><InlineVisualisation vis={sample} />
      </section>)}</div>
    </div>
  </main></div>;
}
createRoot(document.getElementById("root")).render(<ChartPreview />);
