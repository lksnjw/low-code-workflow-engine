import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useAuthContext } from "../../context/AuthContext";
import { getReviewInbox } from "../../services/execution-review.service";

// Shares the notification bell's small metadata query, not transaction payloads.
// Unresolved tasks come from authoritative server records, never tab activity.
export default function DashboardApprovalQueue() {
  const { user } = useAuthContext();
  const allowed = user?.permissions?.includes("execution:approve") === true;
  const authority = `${user?.roleId || ""}:${[...(user?.permissions || [])].sort().join(",")}`;
  const query = useQuery({ queryKey: ["execution-review-inbox", user?.id, authority, "approval", "open", null],
    queryFn: ({ signal }) => getReviewInbox({ kind: "approval", state: "open", limit: 25 }, signal),
    enabled: Boolean(user?.id && allowed), retry: false, refetchOnMount: "always", refetchInterval: 30000, refetchIntervalInBackground: false, refetchOnWindowFocus: true });
  if (!allowed) return null;
  const data = query.isFetchedAfterMount && !query.error ? query.data : null;
  const items = data?.items || [];
  return <section aria-label="Human approvals waiting for you" className="border-y border-amber-300 py-5 dark:border-amber-800">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">Needs human approval{data ? ` · ${data.hasMore ? "at least " : ""}${items.length}` : ""}</h2>
      <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">Saved review requests for your role, including earlier and overnight runs. No action is approved automatically.</p></div>
      <div className="flex items-center gap-4 text-xs font-semibold"><button type="button" disabled={query.isFetching} onClick={() => query.refetch()} className="text-primary disabled:opacity-40 dark:text-fuchsia-300">Refresh approvals</button><Link to="/executions/reviews?kind=approval" className="text-primary dark:text-fuchsia-300">All review tasks →</Link></div>
    </header>
    {!data && !query.error && <p role="status" className="mt-4 text-sm text-gray-500">Checking saved approvals…</p>}
    {query.error && <p role="alert" className="mt-4 text-sm text-amber-800 dark:text-amber-200">Approval status could not be confirmed. Refresh or open the inbox; this is not an empty queue.</p>}
    {data && !items.length && <p className="mt-4 text-sm text-gray-500">No pending approvals are available to your current role.</p>}
    {items.length > 0 && <ul aria-label="Pending approval tasks" className="mt-3 divide-y divide-gray-200 dark:divide-gray-800">{items.slice(0, 5).map(item => {
      const expired = item.expiresAt && Date.parse(item.expiresAt) <= Date.parse(data.asOf);
      return <li key={`${item.executionId}:${item.reviewId}`} className="flex flex-wrap items-start justify-between gap-3 py-4">
        <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold">{item.workflowName}</h3>
          <p className="mt-1 text-xs">Step: {item.nodeId || "Inspect exact evidence"} · {item.toolName}</p>
          <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-200">{expired ? "Review expired · cannot approve this request" : item.statusLabel}</p>
          <p className="mt-2 text-xs text-gray-500">Requested <time dateTime={item.requestedAt}>{new Date(item.requestedAt).toLocaleString()}</time> · {item.requesterName}</p>
          {item.scheduledFor && <p className="mt-1 text-xs text-gray-500">Scheduled run: <time dateTime={item.scheduledFor}>{new Date(item.scheduledFor).toLocaleString()}</time></p>}
          {item.expiresAt && <p className="mt-1 text-xs text-gray-500">Approval expires <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString()}</time></p>}
        </div>
        <Link to={`/executions/${encodeURIComponent(item.executionId)}?view=approval&approvalId=${encodeURIComponent(item.reviewId)}`} className="inline-flex min-h-9 items-center rounded-md border border-amber-400 px-3 text-xs font-semibold text-amber-900 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-950">{expired || !item.reviewAvailable ? "Inspect review issue" : "Open exact review"}<span className="sr-only"> for {item.workflowName}</span></Link>
      </li>;
    })}</ul>}
    {data && (items.length > 5 || data.hasMore) && <p className="mt-2 text-xs text-gray-500">Showing the latest {Math.min(items.length, 5)} requests. Open All review tasks for older requests and decision history.</p>}
  </section>;
}
