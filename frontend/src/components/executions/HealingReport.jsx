import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";

function Content({ report }) {
  if (!report || report.status === "NO_HEALING_REQUIRED") return <p className="text-sm text-gray-500">No self-healing action was required.</p>;
  return (
    <div className="flex items-start gap-4">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300"><Icon icon="mdi:shield-refresh-outline" className="h-6 w-6" /></span>
      <div><h2 className="section-title">Self-Healing Report</h2><p className="mt-2 text-xs font-bold uppercase tracking-wide text-fuchsia-600">{report.status}</p><p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{report.summary}</p></div>
    </div>
  );
}

function HealingReport({ report, embedded = false }) {
  return embedded ? <Content report={report} /> : <Card><Content report={report} /></Card>;
}

export default HealingReport;
