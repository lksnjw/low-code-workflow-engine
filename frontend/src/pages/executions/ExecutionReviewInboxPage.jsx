import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { getReviewInbox } from "../../services/execution-review.service";
import { useAuthContext } from "../../context/AuthContext";
import Button from "../../components/shared/ui/Button";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";

export default function ExecutionReviewInboxPage() {
  const { user } = useAuthContext();
  const [search, setSearch] = useSearchParams();
  const kind = ["approval", "reconciliation"].includes(search.get("kind")) ? search.get("kind") : "all";
  const state = search.get("state") === "closed" ? "closed" : "open";
  const authority = `${user?.roleId || ""}:${[...(user?.permissions || [])].sort().join(",")}`;
  // Filter, account and authority changes discard old cursor/page history,
  // including browser Back/Forward rather than only select-change events.
  return <InboxContent key={`${user?.id}:${authority}:${kind}:${state}`} user={user} authority={authority} kind={kind} state={state}
    onFilter={(key, value) => setSearch({ kind, state, [key]: value })} />;
}
function InboxContent({ user, authority, kind, state, onFilter }) {
  const [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]);
  const query = useQuery({ queryKey: ["execution-review-inbox", user?.id, authority, kind, state, cursor],
    queryFn: ({ signal }) => getReviewInbox({ kind, state, limit: 25, ...(cursor ? { cursor } : {}) }, signal),
    enabled: !!user?.id, retry: false, refetchOnWindowFocus: true, refetchInterval: 30000, refetchIntervalInBackground: false });
  const refresh = () => { setPrevious([]); if (cursor) setCursor(null); else void query.refetch(); };
  // A cached task may already have been approved while this page was closed.
  // Confirm this mount/page before presenting its tasks as current.
  const data = query.isFetchedAfterMount ? query.data : null;
  return <div className="mx-auto max-w-5xl space-y-6 pb-6 text-gray-900 dark:text-gray-100">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="page-heading text-gray-950 dark:text-white">Review inbox</h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500 dark:text-gray-400">Exact action approvals and uncertain outcomes for your current role. Open a task to inspect its details.</p></div>
      <Button variant="secondary" onClick={refresh} disabled={query.isFetching}>Refresh inbox</Button>
    </header>
    <div className="flex flex-wrap items-end gap-4 border-b border-gray-200 pb-4 dark:border-gray-800">
      <label className="grid gap-1 text-sm font-medium">View<select value={state} onChange={event => onFilter("state", event.target.value)} className="min-h-10 min-w-44 rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
        <option value="open">Needs review</option><option value="closed">Decision history</option></select></label>
      <label className="grid gap-1 text-sm font-medium">Task type<select value={kind} onChange={event => onFilter("kind", event.target.value)} className="min-h-10 min-w-44 rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
        <option value="all">All review types</option><option value="approval">Action approvals</option><option value="reconciliation">Uncertain outcomes</option></select></label>
      <p role="status" className="text-xs text-gray-500 dark:text-gray-400">{query.isFetching ? "Refreshing current tasks…" : data && !query.error ? <>Updated <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleTimeString()}</time></> : "Current tasks unavailable"}</p>
    </div>
    {query.isLoading || query.isFetching && !query.isFetchedAfterMount ? <LoadingState label="Loading your review tasks…" /> : null}
    {query.error ? <><ErrorState error={query.error} message={query.error?.response?.data?.message || query.error.message} onRetry={refresh} />
      <p className="text-sm text-gray-500 dark:text-gray-400">Tasks are hidden until the current page is confirmed. Refresh returns to the first page.</p></> : null}
    {!query.error && data ? <>
      {!data.scopes.approval && kind !== "reconciliation" ? <p className="text-sm text-gray-500 dark:text-gray-400">Action approvals appear only when your current role is assigned by the active approval policy.</p> : null}
      <p className="text-sm text-gray-500 dark:text-gray-400">{state === "closed" ? "This is decision history, not run success or delivery confirmation." : "This list cannot approve, execute, resume or resend an action."}</p>
      {data.items.length === 0 ? <section className="py-8"><h2 className="text-base font-semibold">{state === "open" ? "No review tasks on this page" : "No decision records on this page"}</h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Only exact runtime reviews available to your current role are included. Legacy waits and unsupported recovery profiles are not shown.</p></section> :
        <ul aria-label="Review tasks" className="divide-y divide-gray-200 dark:divide-gray-800">{data.items.map(item => <li key={`${item.kind}:${item.executionId}:${item.reviewId}`} className="grid gap-3 py-5 md:grid-cols-[minmax(0,1fr)_minmax(180px,260px)]">
          <div className="min-w-0"><p className="text-xs font-medium text-gray-500 dark:text-gray-400">{item.kind === "approval" ? "Action approval" : item.reviewView === "report-page" ? "Uncertain report page" : "Uncertain outcome"}</p>
            <h2 className="mt-1 break-words text-base font-semibold text-gray-950 dark:text-white">{item.workflowName}</h2>
            <p className="mt-1 break-words text-sm">{item.toolName}{item.nodeId ? <span className="text-gray-500 dark:text-gray-400"> · Node {item.nodeId}</span> : null}</p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Requested by {item.requesterName} · <time dateTime={item.requestedAt}>{new Date(item.requestedAt).toLocaleString()}</time></p>
            {item.scheduledFor && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Scheduled run · <time dateTime={item.scheduledFor}>{new Date(item.scheduledFor).toLocaleString()}</time></p>}
            {item.expiresAt ? <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Approval expires <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString()}</time></p> : null}
          </div>
          <div className="min-w-0"><p className="text-sm font-semibold">{item.statusLabel}</p><p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{item.detail}</p>
            <Link className="mt-3 inline-flex min-h-10 items-center text-sm font-semibold text-primary transition-colors hover:underline focus-visible:outline focus-visible:outline-2 dark:text-violet-300"
              to={`/executions/${encodeURIComponent(item.executionId)}?view=${item.kind === "approval" ? `approval&approvalId=${encodeURIComponent(item.reviewId)}` : item.reviewView}`}>{item.reviewAvailable ? state === "closed" ? "Inspect decision" : "Open exact review" : "Inspect review issue"}<span className="sr-only"> for {item.workflowName}</span></Link>
          </div></li>)}</ul>}
      <nav aria-label="Review inbox pages" className="flex flex-wrap gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
        {previous.length ? <Button variant="secondary" disabled={query.isFetching} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>Previous page</Button> : null}
        {data.hasMore ? <Button variant="secondary" disabled={query.isFetching} onClick={() => { setPrevious([...previous, cursor]); setCursor(data.nextCursor); }}>Next page</Button> : null}
      </nav>
    </> : null}
  </div>;
}
