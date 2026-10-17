import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuthContext } from "../../context/AuthContext";
import { taskDashboardService } from "../../services/task-dashboard.service";
import { calendarDate, calendarLabel, calendarTimezone, moveCalendarMonth } from "../../utils/taskCalendar";
import TaskCalendar from "../../components/dashboard/TaskCalendar";
import DashboardTaskList from "../../components/dashboard/DashboardTaskList";
import DashboardApprovalQueue from "../../components/dashboard/DashboardApprovalQueue";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import usePermissions from "../../hooks/usePermissions";

export default function DashboardPage() {
  const { user } = useAuthContext(), { hasAny } = usePermissions();
  const canReadTasks = hasAny(["workflow:read", "workflow:read_own", "execution:read_own"]);
  const timezone = calendarTimezone(user?.timezone);
  const [month, setMonth] = useState(() => calendarDate(new Date(), timezone).slice(0, 7));
  const [selected, setSelected] = useState(null), [tab, setTab] = useState("day");
  const query = useQuery({ queryKey: ["personal-dashboard", user?.id, user?.permissions, month, timezone],
    queryFn: ({ signal }) => taskDashboardService.load(month, timezone, signal), enabled: !!user?.id && canReadTasks,
    refetchInterval: 15000, refetchIntervalInBackground: false, retry: false });
  const data = query.data, date = selected ?? (data?.today?.startsWith(month) ? data.today : `${month}-01`);
  const chooseDate = date => { setSelected(date); setTab("day"); };
  const navigateTabs = event => {
    const tabs = ["day", "ongoing", "attention"], index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
    if (next === null) return;
    event.preventDefault(); setTab(tabs[next]); document.getElementById(`task-tab-${tabs[next]}`)?.focus();
  };
  const tasks = !data ? [] : tab === "ongoing" ? data.ongoing : tab === "attention" ? data.attention : data.events.filter(task => task.date === date);
  return <div className="mx-auto max-w-6xl space-y-8 pb-8 text-gray-950 dark:text-gray-100">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="page-heading">Dashboard</h1><p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Your daily tasks, ongoing runs and important dates.</p></div>
      <div className="flex items-center gap-3">
        {hasAny(["chat:use", "workflow:write"]) ? <Link to="/" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90">Open workspace</Link> : null}
        {canReadTasks && <button type="button" aria-label="Refresh tasks" disabled={query.isFetching} onClick={() => query.refetch()} className="rounded-lg border border-gray-200 p-2.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 disabled:opacity-40"><RefreshCw size={17} /></button>}
      </div>
    </header>
    <DashboardApprovalQueue />
    {canReadTasks && query.isLoading ? <LoadingState label="Loading your saved tasks…" /> : null}
    {canReadTasks && query.isError ? <ErrorState message="Your current tasks could not be confirmed. Refresh to load saved status; no action has been started." onRetry={query.refetch} /> : null}
    {canReadTasks && data && !query.isError ? <>
      <dl aria-label="Your own task totals" className="grid grid-cols-2 gap-y-5 border-y border-gray-200 py-6 dark:border-gray-800 sm:grid-cols-4">
        {[["Today’s tasks", data.counts.today], ["Ongoing", data.counts.ongoing], ["My tasks needing attention", data.counts.attention], ["Completed today", data.counts.completedToday]].map(([label, count]) => <div key={label} className="px-2 sm:px-4 first:pl-0"><dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-2 text-3xl font-semibold tracking-tight">{count}</dd></div>)}
      </dl>
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0" aria-label="Your task lists">
          <div role="tablist" aria-label="Task view" className="flex flex-wrap gap-5 border-b border-gray-200 dark:border-gray-800">
            {[["day", "Daily tasks"], ["ongoing", "Ongoing"], ["attention", "Needs attention"]].map(([id, label]) => <button type="button" key={id} role="tab" id={`task-tab-${id}`} aria-selected={tab === id} aria-controls="task-panel" tabIndex={tab === id ? 0 : -1} onKeyDown={navigateTabs} onClick={() => setTab(id)} className={`border-b-2 pb-3 text-sm transition-colors motion-reduce:transition-none ${tab === id ? "border-primary font-semibold text-primary" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"}`}>{label}</button>)}
          </div>
          <div role="tabpanel" id="task-panel" aria-labelledby={`task-tab-${tab}`} className="pt-5">
            <h2 className="text-base font-semibold">{tab === "day" ? calendarLabel(date, { weekday: "long", day: "numeric", month: "long" }) : tab === "ongoing" ? "Currently in progress" : "Review or recovery required"}</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{tab === "day" ? "Saved runs and confirmed schedule dates." : tab === "ongoing" ? "Queued and running tasks, including tasks started earlier." : "Open the saved record to inspect it. No automatic approval or retry."}</p>
            <DashboardTaskList tasks={tasks} timezone={timezone} generatedAt={data.generatedAt} empty={tab === "day" ? data.dayCounts[date]?.total > 0 ? "Additional tasks for this date are outside this limited view. Open run history or the workflow." : "No recorded tasks for this date." : tab === "ongoing" ? "No tasks are currently running or queued." : "No approval or recovery items are recorded."} />
          </div>
        </section>
        <aside className="min-w-0 border-t border-gray-200 pt-6 dark:border-gray-800 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
          <TaskCalendar month={month} today={data.today} selected={date} counts={data.dayCounts} onSelect={chooseDate}
            onMonthChange={offset => { setMonth(moveCalendarMonth(month, offset)); setSelected(null); setTab("day"); }} />
          <button type="button" onClick={() => { setMonth(data.today.slice(0, 7)); chooseDate(data.today); }} className="mt-5 text-xs font-semibold text-primary">Back to today</button>
          <p className="mt-3 break-words text-xs text-gray-500 dark:text-gray-400">Calendar timezone: {data.timezone}</p>
        </aside>
      </div>
      {data.truncated ? <p role="status" className="text-sm text-amber-700 dark:text-amber-200">This view shows a limited task list. Date counts include all saved items; open run history or the workflow for additional records.</p> : null}
      <footer className="border-t border-gray-100 pt-4 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">Updated {new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(data.generatedAt))} · Refreshes every 15 seconds while this page is visible. Completed means the run finished, not that email delivery was verified.</footer>
    </> : null}
  </div>;
}
