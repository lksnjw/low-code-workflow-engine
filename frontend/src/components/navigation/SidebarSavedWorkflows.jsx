import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthContext } from "../../context/AuthContext";
import { workflowService } from "../../services/workflow.service";
import { authorityScope, captureAuthority, isAuthorityCurrent, staleAuthorityError } from "../../utils/authAuthority";

const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function savedWorkflowLocation(workflow, user) {
  const id = encodeURIComponent(workflow.id);
  const canChat = user?.permissions?.some(value => ["chat:use", "workflow:write"].includes(value));
  if (!canChat) return `/workflows/${id}`;
  // Global workflow read access does not grant access to another owner's chat.
  const owner = workflow.ownerRecord ?? workflow.owner;
  const session = owner?.id === user.id && validId(workflow.chatSessionId) ? `/${encodeURIComponent(workflow.chatSessionId)}` : "";
  return `/chat${session}?workflow=${id}`;
}

/** Metadata only, twenty records per page. Source is loaded on selection. */
export default function SidebarSavedWorkflows() {
  const { user } = useAuthContext(), location = useLocation();
  const scope = authorityScope(user), [page, setPage] = useState(1);
  const canRead = Boolean(user?.permissions?.some(value => ["workflow:read", "workflow:read_own"].includes(value)));
  const query = useQuery({
    queryKey: ["workflows", scope, { view: "sidebar", page }], staleTime: 30000, retry: false,
    enabled: Boolean(scope && canRead),
    queryFn: async ({ signal }) => {
      const authority = captureAuthority(user);
      const result = await workflowService.listPage({ relevance: "relevant", page, limit: 20 }, signal);
      if (!isAuthorityCurrent(authority)) throw staleAuthorityError();
      return result;
    },
  });
  if (!canRead) return null;
  const items = query.isError ? [] : (query.data?.items ?? []).filter(item => validId(item.id));
  const selectedId = new URLSearchParams(location.search).get("workflow");
  return <section aria-label="Saved workflows" className="mx-4 mb-4 border-t border-gray-200 pt-4 dark:border-gray-800">
    <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Saved workflows</h3><Link to="/workflows" className="text-[11px] text-primary underline-offset-2 hover:underline">View all</Link></div>
    <p className="mb-2 text-[10px] text-gray-500">Drafts and published workflows · newest first</p>
    {query.isPending && <p role="status" className="py-2 text-xs text-gray-500">Loading saved workflows…</p>}
    {query.isError && <div role="alert" className="py-2 text-xs text-gray-500">Could not load saved workflows. <button type="button" className="text-primary underline" onClick={() => query.refetch()}>Retry workflow list</button></div>}
    {!query.isPending && !query.isError && !items.length && <p className="py-2 text-xs text-gray-500">No saved workflows on this page.</p>}
    <nav aria-label="Saved workflow list" className="space-y-1">{items.map(item => <Link key={item.id} to={savedWorkflowLocation(item, user)} aria-current={selectedId === item.id ? "page" : undefined}
      className={`block rounded-lg px-2 py-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selectedId === item.id ? "bg-primary/10 text-primary" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"}`}>
      <span className="block truncate font-medium" title={item.name}>{item.name || "Untitled workflow"}</span>
      <span className="mt-1 block text-[10px] text-gray-500">{item.publishedVersion > 0 ? item.draftVersion > item.publishedVersion ? `Draft v${item.draftVersion} · published v${item.publishedVersion}` : `Published v${item.publishedVersion}` : "Saved draft"} · {Number.isInteger(item.steps) ? `${item.steps} ${item.steps === 1 ? "step" : "steps"}` : "Open to review"}</span>
    </Link>)}</nav>
    {(page > 1 || query.data?.meta?.totalPages > 1) && <div aria-label="Saved workflow pages" className="mt-3 flex items-center justify-between text-[11px]">
      <button type="button" disabled={page === 1 || query.isFetching} onClick={() => setPage(value => value - 1)} className="text-primary disabled:text-gray-400">Newer workflows</button>
      <span className="text-gray-500">{page}</span>
      <button type="button" disabled={query.isFetching || !query.data || page >= (query.data.meta?.totalPages ?? 1)} onClick={() => setPage(value => value + 1)} className="text-primary disabled:text-gray-400">Older workflows</button>
    </div>}
  </section>;
}
