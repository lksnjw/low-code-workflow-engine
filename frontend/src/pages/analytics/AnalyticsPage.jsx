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

function AnalyticsPage({ view = "performance" }) {
  const { data, loading, error, reload } = useAnalytics();
  if (loading) return <LoadingState label="Loading measured analytics…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const summary = data?.summary || {};
  const titles = {
    performance: ["Execution Performance", "Measured throughput, latency, and successful terminal outcomes."],
    usage: ["Usage & Cost", "Recorded token usage and execution cost without projected sample data."],
    healing: ["Self-Healing", "Repair attempts and validation evidence recorded after execution failures."],
  };
  const [title, description] = titles[view] || titles.performance;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
      </div>
      {view === "performance" ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Runs Today" value={summary.runsToday || 0} detail="Recorded since 00:00 UTC" />
            <MetricCard label="Avg Latency" value={`${Number(summary.avgLatencyMs || 0)}ms`} detail="Completed executions" />
            <DonutChart successRate={summary.successRate} />
            <F1ScoreGauge data={data?.f1} />
          </section>
          <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <BarChart data={data?.performance} />
            <HeatmapCalendar data={data?.heatmap} />
          </section>
        </>
      ) : null}
      {view === "usage" ? (
        <section className="grid gap-4 xl:grid-cols-[0.7fr_1.3fr]">
          <UsageTrendCard summary={summary} />
          <LineChart data={data?.costs} />
        </section>
      ) : null}
      {view === "healing" ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <HealingSuccessRate data={data?.healing} />
          <MetricCard
            label="Repair attempts"
            value={data?.healing?.attempts || 0}
            detail={`${data?.healing?.failed || 0} failed repairs`}
          />
        </section>
      ) : null}
    </div>
  );
}

export default AnalyticsPage;
