import WelcomeBanner from "../../components/dashboard/WelcomeBanner";
import StatsCard from "../../components/dashboard/StatsCard";
import ActivityFeed from "../../components/dashboard/ActivityFeed";
import QuickActions from "../../components/dashboard/QuickActions";
import SystemHealth from "../../components/dashboard/SystemHealth";
import RecentWorkflows from "../../components/dashboard/RecentWorkflows";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useDashboard } from "../../hooks/useDashboard";

function DashboardPage({ view = "overview" }) {
  const { data, loading, error, reload } = useDashboard();
  if (loading) return <LoadingState label="Loading platform state…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  if (view === "activity") {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="page-heading text-gray-950 dark:text-white">Platform Activity</h1>
          <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
            Recorded workflow runs, governance decisions, and recovery events.
          </p>
        </div>
        <ActivityFeed items={data?.activity || []} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WelcomeBanner />
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(data?.metrics || []).map((metric) => <StatsCard key={metric.key || metric.label} metric={metric} />)}
      </section>
      <section className="grid gap-4 xl:grid-cols-[1.45fr_0.8fr]">
        <RecentWorkflows workflows={data?.workflows || []} />
        <div className="grid gap-4">
          <QuickActions />
          <SystemHealth services={data?.health?.services || []} />
        </div>
      </section>
      <ActivityFeed items={data?.activity || []} />
    </div>
  );
}

export default DashboardPage;
