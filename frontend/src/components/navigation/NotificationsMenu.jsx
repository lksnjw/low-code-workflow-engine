import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "@iconify/react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { notificationService } from "../../services/notification.service";
import { getReviewInbox } from "../../services/execution-review.service";
import { hasPermission } from "../../utils/permission.utils";
import { useNotifications } from "../../context/NotificationContext";

export default function NotificationsMenu({ user }) {
  const { activity = [], markActivityRead } = useNotifications();
  const [open, setOpen] = useState(false), ref = useRef(null);
  const [dismissedAttention, setDismissedAttention] = useState([]);
  const [marking, setMarking] = useState(""), [updateError, setUpdateError] = useState("");
  useClickOutside(ref, () => setOpen(false));
  const authority = `${user?.roleId || ""}:${[...(user?.permissions || [])].sort().join(",")}`;
  const canReview = hasPermission(user, "execution:approve");
  const approvals = useQuery({
    queryKey: ["execution-review-inbox", user?.id, authority, "approval", "open", null],
    queryFn: ({ signal }) => getReviewInbox({ kind: "approval", state: "open", limit: 25 }, signal),
    enabled: !!user?.id && canReview, retry: false, refetchInterval: 30000,
    refetchIntervalInBackground: false, refetchOnWindowFocus: true,
  });
  const updates = useQuery({ queryKey: ["notifications", "unread", user?.id, authority],
    queryFn: () => notificationService.list({ unreadOnly: true, limit: 100 }),
    enabled: !!user?.id, retry: false, refetchInterval: 30000, refetchIntervalInBackground: false });
  // Never show another account's tasks or treat an unavailable inbox as empty.
  const current = canReview && approvals.isFetchedAfterMount && !approvals.isError ? approvals.data : null;
  const items = current?.items ?? [];
  const attention = items.find(item => item.reviewAvailable && !dismissedAttention.includes(`${user?.id}:${item.executionId}:${item.reviewId}`));
  const unread = updates.isFetchedAfterMount && !updates.isError && user?.id ? (updates.data ?? []).filter(item => item.read !== true && [item.recipientId, item.ownerId, item.userId].includes(user.id)) : [];
  const count = items.length + unread.length + activity.filter(item => !item.read).length;
  const countLabel = count > 99 ? "99+" : `${count}${current?.hasMore ? "+" : ""}`;
  const toggle = () => {
    setOpen(value => !value);
    if (!open) { if (canReview) void approvals.refetch(); void updates.refetch(); }
  };
  const acknowledge = async id => {
    if (marking) return; setMarking(id); setUpdateError("");
    try { await notificationService.markRead(id); await updates.refetch(); }
    catch { setUpdateError("The update was not confirmed as read. Reopen notifications and try again."); }
    finally { setMarking(""); }
  };
  return <div className="relative" ref={ref} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="icon-button relative" aria-label="Notifications" aria-expanded={open} aria-controls="workspace-notifications" onClick={toggle}>
      <Icon icon="mdi:bell-outline" className="h-5 w-5" />
      {count > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-primary px-1 text-[10px] font-bold text-white dark:border-gray-900">{countLabel}</span>}
      <span className="sr-only" aria-live="polite">{count > 0 ? `${countLabel} items need attention` : ""}</span>
    </button>
    {attention && !open && <aside role="status" aria-live="polite" aria-label="Approval needs your attention" className="workspace-reveal fixed bottom-5 right-5 z-50 w-80 max-w-[calc(100vw-2.5rem)] rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-lg dark:border-amber-700 dark:bg-gray-900">
      <div className="flex items-start gap-2"><Icon icon="lucide:bell-ring" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold">Approval needed</p><p className="mt-1 break-words text-xs text-gray-600 dark:text-gray-300">{attention.workflowName}</p></div><button type="button" aria-label="Dismiss approval reminder" className="rounded p-1 text-gray-500 hover:bg-amber-100 dark:hover:bg-gray-800" onClick={() => setDismissedAttention(items => [...items, `${user?.id}:${attention.executionId}:${attention.reviewId}`])}><Icon icon="lucide:x" /></button></div>
      <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">The workflow is paused. Review the requested action to continue.</p>
      <Link to={`/executions/${encodeURIComponent(attention.executionId)}?view=approval&approvalId=${encodeURIComponent(attention.reviewId)}`} className="mt-3 inline-flex min-h-9 items-center rounded-md bg-amber-600 px-3 text-xs font-semibold text-white" onClick={() => setDismissedAttention(items => [...items, `${user?.id}:${attention.executionId}:${attention.reviewId}`])}>Review request</Link>
    </aside>}
    {open && <section id="workspace-notifications" aria-label="Notifications panel" className="absolute right-0 top-full z-50 mt-3 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
      <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800"><h2 className="text-sm font-semibold">Notifications</h2><button type="button" aria-label="Close notifications" onClick={() => setOpen(false)} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"><Icon icon="lucide:x" /></button></header>
      <div className="max-h-96 overflow-y-auto px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Approvals</h3>
        {!canReview ? <p className="mt-2 text-xs leading-5 text-gray-500">Approval requests go to the assigned reviewers. Your workflow shows when it is waiting.</p> : approvals.isError ? <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">Approval requests could not be loaded. Open the inbox to retry.</p> : !current ? <p role="status" className="mt-2 text-xs text-gray-500">Checking approval requests…</p> : items.length === 0 ? <p className="mt-2 text-xs leading-5 text-gray-500">No approval requests assigned to you.</p> : <ul className="divide-y divide-gray-100 dark:divide-gray-800">{items.map(item => <li key={`${item.executionId}:${item.reviewId}`} className="py-3">
          <p className="text-sm font-semibold">{item.workflowName}</p><p className="mt-1 text-xs text-gray-500">{item.toolName} · Requested by {item.requesterName}</p>
          <Link className="mt-2 inline-flex min-h-8 items-center text-xs font-semibold text-primary dark:text-fuchsia-300" onClick={() => setOpen(false)} to={`/executions/${encodeURIComponent(item.executionId)}?view=approval&approvalId=${encodeURIComponent(item.reviewId)}`}>{item.reviewAvailable ? "Review approval" : "Inspect approval issue"}</Link>
        </li>)}</ul>}
        <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800"><h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Saved updates</h3>
          {updates.isError ? <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">Saved updates could not be loaded. Reopen notifications to retry; an unavailable feed is not an empty feed.</p> : !updates.isFetchedAfterMount ? <p role="status" className="mt-2 text-xs text-gray-500">Loading saved updates…</p> : unread.length ? <ul className="mt-2 space-y-2">{unread.slice(0, 10).map((item, index) => <li key={item.id ?? index} className="text-xs leading-5"><p>{item.title || item.message || "New workspace update"}</p>{item.id && <button type="button" disabled={Boolean(marking)} onClick={() => acknowledge(item.id)} className="mt-1 font-semibold text-primary disabled:opacity-50">{marking===item.id ? "Saving…" : "Mark read"}</button>}</li>)}</ul> : <p className="mt-2 text-xs text-gray-500">No unread saved updates.</p>}
          {updateError && <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{updateError}</p>}
        </div>
        <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800"><div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Recent activity</h3>{activity.some(item => !item.read) && <button type="button" onClick={() => markActivityRead?.()} className="text-xs font-semibold text-primary">Mark activity read</button>}</div>
          <p className="mt-1 text-[11px] text-gray-500">Messages from this signed-in tab. Cleared on reload or account change.</p>
          {activity.length ? <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">{activity.slice(0, 10).map(item => <li key={item.id} className="py-2 text-xs leading-5"><p className={item.read ? "text-gray-500" : "font-semibold"}>{item.message}</p><time className="text-[10px] text-gray-500" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString()}</time></li>)}</ul> : <p className="mt-2 text-xs text-gray-500">No recent activity in this tab.</p>}
        </div>
      </div>
      {canReview && <Link onClick={() => setOpen(false)} to="/executions/reviews?kind=approval" className="block border-t border-gray-100 px-4 py-3 text-center text-xs font-semibold text-primary hover:bg-gray-50 dark:border-gray-800 dark:text-fuchsia-300 dark:hover:bg-gray-800">Open approval inbox</Link>}
    </section>}
  </div>;
}
