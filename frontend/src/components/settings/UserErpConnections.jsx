import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { userErpService } from "../../services/user-erp.service";
import Button from "../shared/ui/Button";
import { ErrorState, LoadingState } from "../shared/ResourceState";

// Key the whole panel by authenticated account. Never cache a token, put it in
// navigation/history, or echo a backend/remote error that might contain one.
export default function UserErpConnections({ actorId }) {
  const client = useQueryClient();
  const queryKey = ["my-erp-connections", actorId];
  const query = useQuery({ queryKey, queryFn: userErpService.list, enabled: Boolean(actorId) });
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => { setNotice(""); setBusy(""); }, [actorId]);
  const perform = async (id, action, body) => {
    setBusy(`${id}:${action}`); setNotice(""); setFailed(false);
    try {
      const result = await userErpService[action](id, body);
      client.setQueryData(queryKey, result);
      setNotice(action === "save" ? "Your token was saved securely. Test the connection before using ERP tools."
        : action === "remove" ? "Your token was removed. New ERP calls and old queued requests cannot use it."
          : "Token connection and discovery passed. Tool access is still checked for every call; no business operation was performed.");
    } catch (error) {
      setFailed(true);
      setNotice(error?.response?.status === 409 ? "The connection changed. Reload your ERP connections before trying again."
        : "The request could not be confirmed. Reload your ERP connections to check saved state. No automatic retry was sent.");
    } finally { setBusy(""); }
  };
  if (!actorId) return null;
  return <section aria-label="My ERP connections" className="mt-6 border-t border-gray-200 pt-6 text-gray-900 dark:border-gray-700 dark:text-gray-100">
    <h2 className="section-title">My ERP connections</h2>
    <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{query.data?.credentialMode === "administrator-environment"
      ? "Your built-in Platform Admin account uses the ERPBridge credential held in server environment/secret configuration. Other roles must add their own tokens. Tool, role, policy and approval checks still apply."
      : "Use your own ERPBridge bearer token. Your platform role and the ERP permissions on that token both apply. The administrator’s catalog token is not used for your ERP operations."}</p>
    <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">Enter an ERPBridge token, not an ERP database password or a raw ERP API key. Tokens are stored encrypted on the server and are never sent to the workflow assistant.</p>
    {query.isLoading ? <LoadingState label="Loading your ERP connections…" /> : query.error ? <ErrorState error={new Error("Your ERP connection settings could not be loaded.")} onRetry={query.refetch} />
      : <div className="mt-5 divide-y divide-gray-200 dark:divide-gray-700">{(query.data?.connections || []).map(connection => <Connection key={`${actorId}:${connection.id}:${connection.revision}`} connection={connection} busy={Boolean(busy)} onAction={perform} />)}
        {query.data?.connections?.length === 0 && <p className="py-4 text-sm text-gray-600 dark:text-gray-400">An administrator must configure an ERPBridge endpoint first.</p>}
      </div>}
    {busy && <p role="status" className="mt-3 text-sm text-gray-600 dark:text-gray-400">{busy.endsWith(":test") ? "Checking token connection and discovery… No business tool is being called." : "Saving your ERP connection settings…"}</p>}
    {notice && <p role={failed ? "alert" : "status"} className={`mt-3 text-sm ${failed ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>{notice}</p>}
    <Button type="button" variant="secondary" className="mt-4" disabled={Boolean(busy) || query.isFetching} onClick={() => query.refetch()}>Reload my ERP connections</Button>
  </section>;
}
function Connection({ connection, busy, onAction }) {
  const [token, setToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const command = action => { setToken(""); setConfirmRemove(false); return onAction(connection.id, action, { baseRevision: connection.revision }); };
  if (connection.source === "administrator-environment") return <div className="py-5">
    <div className="flex flex-wrap items-baseline gap-3"><h3 className="text-sm font-semibold">{connection.id}</h3><span className="text-xs text-gray-600 dark:text-gray-400">Administrator environment credential · value hidden</span></div>
    <p className="mt-1 break-all text-xs text-gray-600 dark:text-gray-400">{connection.endpoint}</p>
    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Managed on the backend. This page cannot display, replace or remove the server credential.</p>
    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{connection.testedAt ? `Last successful connection test: ${new Date(connection.testedAt).toLocaleString()}` : "Not tested in this server session."}</p>
    <Button type="button" variant="secondary" className="mt-3" disabled={busy || !connection.configured} onClick={() => command("test")}>Test administrator connection</Button>
  </div>;
  return <div className="py-5">
    <div className="flex flex-wrap items-baseline gap-3"><h3 className="text-sm font-semibold">{connection.id}</h3><span className="text-xs text-gray-600 dark:text-gray-400">{connection.configured ? "Token saved · value hidden" : "No personal token"}</span></div>
    <p className="mt-1 break-all text-xs text-gray-600 dark:text-gray-400">{connection.endpoint}</p>
    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{connection.testedAt ? `Last successful connection test: ${new Date(connection.testedAt).toLocaleString()}` : "Connection not tested for this token revision."}</p>
    <form className="mt-4 max-w-2xl" onSubmit={event => {
      event.preventDefault(); const submitted = token; setToken("");
      void onAction(connection.id, "save", { baseRevision: connection.revision, token: submitted });
    }}>
      <label className="block text-xs font-semibold" htmlFor={`erp-token-${connection.id}`}>{connection.configured ? "Replace my ERPBridge token" : "My ERPBridge token"}</label>
      <input id={`erp-token-${connection.id}`} type="password" autoComplete="off" spellCheck={false} required disabled={busy} value={token}
        onChange={event => setToken(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary dark:border-gray-600" />
      <div className="mt-3 flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || token.trim().length < 8}>{connection.configured ? "Replace my token" : "Save my token"}</Button>
        <Button type="button" variant="secondary" disabled={busy || !connection.configured} onClick={() => command("test")}>Test my connection</Button>
        {connection.configured && <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove my token</Button>}
      </div>
    </form>
    {confirmRemove && <div className="mt-3 text-sm"><p>Remove this token? Queued work keeps its original credential revision and will need a new reviewed request.</p><div className="mt-2 flex gap-3">
      <Button type="button" disabled={busy} onClick={() => command("remove")}>Confirm token removal</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep my token</Button>
    </div></div>}
  </div>;
}
