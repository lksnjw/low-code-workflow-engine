import BarChart from "../../components/analytics/BarChart";
import DonutChart from "../../components/analytics/DonutChart";
import F1ScoreGauge from "../../components/analytics/F1ScoreGauge";
import HealingSuccessRate from "../../components/analytics/HealingSuccessRate";
import HeatmapCalendar from "../../components/analytics/HeatmapCalendar";
import LineChart from "../../components/analytics/LineChart";
import MetricCard from "../../components/analytics/MetricCard";
import UsageTrendCard from "../../components/analytics/UsageTrendCard";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useAnalytics } from "../../hooks/useAnalytics";

function AnalyticsPage() {
  const { data, loading, error, reload } = useAnalytics();
  if (loading) return <LoadingState label="Loading measured analytics…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const summary = data?.summary || {};
  return <div className="space-y-6"><div><h1 className="page-heading text-gray-950 dark:text-white">Workflow Analytics</h1><p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">Metrics are derived from recorded workflow executions—no demo values.</p></div>
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><MetricCard label="Runs Today" value={summary.runsToday || 0} detail="Recorded since 00:00 UTC" /><MetricCard label="Avg Latency" value={`${Number(summary.avgLatencyMs || 0)}ms`} detail="Completed executions" /><UsageTrendCard summary={summary} /><HealingSuccessRate data={data?.healing} /></section>
    <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]"><BarChart data={data?.performance} /><DonutChart successRate={summary.successRate} /></section>
    <section className="grid gap-4 xl:grid-cols-3"><LineChart data={data?.costs} /><F1ScoreGauge data={data?.f1} /><HeatmapCalendar data={data?.heatmap} /></section>
  </div>;
}

export default AnalyticsPage;
