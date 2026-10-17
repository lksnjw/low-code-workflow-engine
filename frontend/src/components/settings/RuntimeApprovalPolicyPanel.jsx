import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePermissions } from "../../hooks/usePermissions";
import { approvalPolicyService, sameApprovalPolicy, validApprovalPolicy } from "../../services/approval-policy.service";
import Button from "../shared/ui/Button";

const keyFor = actorId => `workflow.approval-policy.${encodeURIComponent(actorId)}`;
function restore(actorId) {
  try { const raw = sessionStorage.getItem(keyFor(actorId)); if (raw === null) return null;
    const value = JSON.parse(raw); return value?.unconfirmed === true ? value : { unconfirmed: true }; }
  catch { return { unconfirmed: true }; }
}
export default function RuntimeApprovalPolicyPanel() {
  const { actorId, roleId, role, has } = usePermissions();
  if (!has("settings:manage")) return null;
  return <PolicyWorkspace key={`${actorId}:${roleId}:${role}`} actorId={actorId} locallyManageable={role === "Platform Admin"} />;
}
function PolicyWorkspace({ actorId, locallyManageable }) {
  const client = useQueryClient(), lock = useRef(false);
  const [pending, setPending] = useState(() => restore(actorId)), [busy, setBusy] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const query = useQuery({ queryKey: ["approval-policy", actorId], queryFn: ({ signal }) => approvalPolicyService.load(signal),
    enabled: !!actorId, retry: false, refetchOnWindowFocus: true });
  const data = !query.error && query.isFetchedAfterMount ? query.data : null;
  async function reload() {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await query.refetch(); if (result.error || !result.data) throw result.error || new Error("No authoritative policy was returned.");
      sessionStorage.removeItem(keyFor(actorId)); setPending(null);
      setEditorEpoch(value => value + 1);
      setMessage("Current saved policy reloaded. This does not prove an earlier request was acknowledged or execute a workflow.");
    } catch (failure) { setError(failure?.response?.data?.message || failure.message || "Approval settings could not be confirmed."); }
    finally { lock.current = false; setBusy(false); }
  }
  async function save(command) {
    if (lock.current || pending || !data?.canManage || !locallyManageable || query.isFetching) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      // Persist a lock before dispatch, not a browser-held authorization or
      // a retryable command. Reload must precede another configuration change.
      const marker = { unconfirmed: true, baseRevision: command.baseRevision };
      sessionStorage.setItem(keyFor(actorId), JSON.stringify(marker)); setPending(marker);
      const acknowledged = await approvalPolicyService.save(command);
      const fresh = await query.refetch(); if (fresh.error || !fresh.data) throw fresh.error || new Error("Saved policy could not be freshly confirmed.");
      if (!sameApprovalPolicy(fresh.data.policy, acknowledged)) throw new Error("The current policy differs from the acknowledgement. Reload and review it; do not resend.");
      sessionStorage.removeItem(keyFor(actorId)); setPending(null);
      setMessage(`Approval policy revision ${acknowledged.revision} saved and freshly confirmed. No tool or workflow was executed.`);
      await Promise.all([client.invalidateQueries({ queryKey: ["settings"] }), client.invalidateQueries({ queryKey: ["execution-review-inbox"] }), client.invalidateQueries({ queryKey: ["execution-approval"] })]);
    } catch (failure) { setError(failure?.response?.data?.message || failure.message || "Policy save could not be confirmed. Reload before another change."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section aria-label="Runtime approval policy" className="space-y-4 border-y border-gray-200 py-5 text-gray-900 dark:border-gray-800 dark:text-gray-100">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="section-title">Runtime approvals</h2>
      <p className="mt-2 max-w-xl text-sm text-gray-500 dark:text-gray-400">Configure who may review an exact operation and how long its approval remains valid. The requester cannot approve their own action.</p></div>
      <Button variant="secondary" disabled={busy || query.isFetching} onClick={reload}>Reload saved policy</Button></div>
    {query.isFetching ? <p role="status" className="text-sm">Checking current approval settings…</p> : null}
    {query.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{query.error?.response?.data?.message || query.error.message || "Approval settings unavailable. No policy is editable."}</p> : null}
    {pending ? <p role="status" className="border-l-2 border-amber-500 pl-3 text-sm">Unconfirmed policy change. Reload saved policy before making another change; this screen never retries the request automatically.</p> : null}
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {message ? <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{message}</p> : null}
    {data ? <>
      <p className="text-sm font-medium">{data.policy ? `Saved revision ${data.revision} · ${data.policy.enabled ? "Enabled" : "Disabled—governed effects blocked"}` : "Not configured—governed effects blocked"}</p>
      {data.memoryOnly ? <p className="text-xs text-gray-500 dark:text-gray-400">Memory-only settings do not survive a backend restart.</p> : null}
      {!data.canManage || !locallyManageable ? <p className="text-sm">Read only. Current Platform Admin authority is required to change this policy.</p> : null}
      <PolicyEditor key={JSON.stringify([editorEpoch, data.policy, data.roles, data.canManage])} data={data}
        locked={busy || !!pending || query.isFetching || !data.canManage || !locallyManageable} onSave={save} />
    </> : null}
  </section>;
}
function PolicyEditor({ data, locked, onSave }) {
  const [enabled, setEnabled] = useState(data.policy?.enabled ?? false), [ttl, setTtl] = useState(String(data.policy?.ttlSeconds ?? 300));
  const [selected, setSelected] = useState(data.policy?.approverRoleIds ?? []), [reviewed, setReviewed] = useState(false);
  const command = { profile: "runtime-approval-policy/v1", baseRevision: data.revision, enabled, ttlSeconds: Number(ttl), approverRoleIds: selected, separationOfDuties: true };
  const valid = validApprovalPolicy(command, true) && selected.every(id => data.roles.some(role => role.id === id && role.eligible));
  const changed = !data.policy || enabled !== data.policy.enabled || Number(ttl) !== data.policy.ttlSeconds || JSON.stringify(selected) !== JSON.stringify(data.policy.approverRoleIds);
  const change = callback => { setReviewed(false); callback(); };
  return <form onSubmit={event => { event.preventDefault(); if (reviewed && valid && changed && !locked) void onSave(command); }} className="space-y-4">
    <fieldset disabled={locked} className="space-y-4">
      <label className="flex min-h-10 items-start gap-3 text-sm"><input type="checkbox" checked={enabled} onChange={event => change(() => setEnabled(event.target.checked))} className="mt-1" />Enable independent runtime approvals</label>
      <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">Disabled or unconfigured approval policy blocks governed effects; it never permits writes without approval. Changing policy can invalidate existing pending or approved waits.</p>
      <label className="grid max-w-xs gap-1 text-sm font-medium">Approval validity in seconds<input type="number" min="60" max="86400" step="1" required value={ttl} onChange={event => change(() => setTtl(event.target.value))}
        className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900" /><span className="text-xs font-normal text-gray-500 dark:text-gray-400">60–86,400 seconds. Saved expiry is checked again before dispatch.</span></label>
      <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">For overnight schedules, choose a validity that covers the intended morning review, up to 24 hours. Expired requests remain inspectable but cannot be approved. Set this before starting the run; changing the policy can invalidate existing reviews.</p>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold">Independent reviewer roles</legend>
        {data.roles.length === 0 ? <p className="text-sm">No eligible roles. An authorized role administrator must assign execution:approve separately; this form does not grant permissions.</p> : data.roles.map(role => <label key={role.id} className="flex min-h-10 items-start gap-3 text-sm">
          <input type="checkbox" checked={selected.includes(role.id)} disabled={!role.eligible && !selected.includes(role.id)} onChange={event => change(() => setSelected(event.target.checked ? [...selected, role.id] : selected.filter(id => id !== role.id)))} className="mt-1" />
          <span className="min-w-0 break-words">{role.name}{!role.eligible ? <span className="block text-xs text-amber-700 dark:text-amber-300">No longer eligible. Remove it before saving; no permission is granted here.</span> : null}</span></label>)}
      </fieldset>
      <p className="text-sm">Separation of duties is mandatory. At least one, and at most 20, distinct eligible roles must be selected.</p>
      {!valid ? <p className="text-sm text-amber-700 dark:text-amber-300">Select eligible reviewer roles and a whole-number validity between 60 and 86,400 seconds.</p> : null}
      {reviewed ? <div role="group" aria-label="Review approval policy change" className="space-y-3 border-l-2 border-primary pl-4">
        <h3 className="text-sm font-semibold">Review policy revision {data.revision} → {data.revision + 1}</h3>
        <p className="text-sm">{enabled ? "Independent approvals enabled" : "Governed effects blocked"} · {Number(ttl)} seconds · Requester self-approval prohibited</p>
        <ul className="list-inside list-disc text-sm">{selected.map(id => <li key={id}>{data.roles.find(role => role.id === id)?.name}</li>)}</ul>
        <p className="text-xs text-gray-500 dark:text-gray-400">This changes approval policy only. It does not approve existing transactions, grant role permissions, execute tools or confirm delivery.</p>
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={locked || !valid || !changed}>Confirm policy change</Button><Button type="button" variant="ghost" onClick={() => setReviewed(false)}>Cancel policy review</Button></div>
      </div> : <Button type="button" disabled={locked || !valid || !changed} onClick={() => setReviewed(true)}>Review policy change</Button>}
    </fieldset>
  </form>;
}
