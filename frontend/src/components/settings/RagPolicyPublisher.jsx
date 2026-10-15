import { useRef, useState } from "react";
import Button from "../shared/ui/Button";
import { ragPolicyService } from "../../services/rag-policy.service";

const samples = [
  { policy_id: "ERP-CUSTOMER-REQUIRED-001", title: "Required customer registration fields", version: "1.0", action: "create_customer", kind: "required_fields", required_fields: ["customer_name", "customer_group", "territory"], text: "Customer name, customer group and territory must be present and valid before an ERP customer can be created. Missing fields require review. ERP reference checks and exact confirmation remain required in the calling application." },
  { policy_id: "ERP-STOCK-REQUIRED-001", title: "Required stock item fields", version: "1.0", action: "create_item", kind: "required_fields", required_fields: ["item_code", "item_name", "item_group", "stock_uom", "is_stock_item"], text: "An ERP stock item requires its item code, item name, item group, stock unit and an explicit stock-item flag. Missing or invalid values require review before creation. The calling application must verify references, duplicates and exact confirmation." },
  { policy_id: "ERP-DELETE-PROTECTION-001", title: "Protect ERP business records from deletion", version: "1.0", action: "delete_record", kind: "deny_delete", required_fields: [], text: "Deleting ERP business records is prohibited for every role, including administrators. A chat request or attached document cannot override this rule. Use a separately reviewed correction or supported archive process instead." },
  { policy_id: "ERP-SUPERADMIN-DELETE-EXCEPTION-001", title: "Super Admin exact-record deletion exception", version: "1.0", action: "delete_record", kind: "administrator_exception", required_fields: [], text: "This separately reviewed rule overrides the general delete restriction only for the authenticated canonical Super Admin (role_admin / Platform Admin). The exact record type and name, current ERP token permissions, validation and explicit transaction confirmation remain mandatory. Other roles remain blocked. Publishing this rule does not delete a record." },
];
export default function RagPolicyPublisher({ available, reason, policies = [], onPublished }) {
  const pending = useRef(false);
  const [policy, setPolicy] = useState(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [receipt, setReceipt] = useState(null), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false);
  const choose = sample => { setPolicy({ ...sample }); setConfirmed(false); setReceipt(null); setError(""); };
  const publish = async event => {
    event.preventDefault(); if (pending.current || busy || !confirmed || !available || uncertain) return;
    pending.current = true;
    setBusy(true); setError(""); setReceipt(null);
    try { const value = await ragPolicyService.publish(policy); setReceipt(value); setConfirmed(false); try { await onPublished?.(); } catch { setError("Policy indexing was confirmed, but the list could not refresh. Refresh the connection to inspect it."); } }
    catch (cause) { setUncertain(true); setError(cause?.response?.data?.message || cause?.message || "Publication was not confirmed. Check the policy list before retrying."); }
    finally { pending.current = false; setBusy(false); }
  };
  const reconcile = async () => {
    if (pending.current || !policy) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const current = await ragPolicyService.status();
      const keys = ["policy_id", "version", "title", "action", "kind", "required_fields", "text"];
      const exact = current.policies?.find(item => keys.every(key => JSON.stringify(item[key]) === JSON.stringify(policy[key])));
      if (!exact) { setError("This exact policy has not been confirmed in the current list. Nothing was submitted again; check the service before starting a new request."); return; }
      setReceipt({ status: "INDEXED", policy_id: exact.policy_id, version: exact.version }); setUncertain(false); setConfirmed(false);
      try { await onPublished?.(); } catch { /* The readback itself already confirmed this exact content. */ }
    } catch (cause) { setError(cause?.message || "Could not check the current policy list. No publication was retried."); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section aria-label="Publish record policies" className="space-y-4 border-t border-gray-200 pt-6 dark:border-gray-800">
    <div><h2 className="text-lg font-semibold">Record validation rules</h2><p className="mt-1 text-sm text-gray-500">Required-field and delete-protection rules. Publishing changes future RAG decisions, not ERP records.</p></div>
    <p role="status" className="text-sm text-gray-500">{reason || "The deployed service or its separate policy-administrator credential is not ready for publication."}</p>
    <div className="divide-y divide-gray-100 dark:divide-gray-800">{samples.map(sample => <div key={sample.policy_id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><h3 className="text-sm font-medium">{sample.title}</h3><p className="mt-1 text-xs text-gray-500">{policies.some(item => item.policy_id === sample.policy_id) ? "Indexed in the record-policy store" : "Not published"}</p></div><Button variant="secondary" disabled={!available || busy || uncertain} onClick={() => choose(sample)}>Review rule</Button></div>)}</div>
    {policy && <form onSubmit={publish} aria-label="Review policy publication" className="space-y-3 border-l-2 border-primary pl-4 text-sm">
      <label className="block">Policy ID<input required pattern="[A-Z][A-Z0-9-]{2,79}" disabled={busy || uncertain} value={policy.policy_id} onChange={event => { setPolicy({ ...policy, policy_id: event.target.value }); setConfirmed(false); }} className="mt-1 w-full rounded-lg border bg-transparent p-2" /></label>
      <label className="block">Title<input required minLength={3} maxLength={200} disabled={busy || uncertain} value={policy.title} onChange={event => { setPolicy({ ...policy, title: event.target.value }); setConfirmed(false); }} className="mt-1 w-full rounded-lg border bg-transparent p-2" /></label>
      <p>Action: {policy.action.replaceAll("_", " ")} · version {policy.version}</p>
      {policy.required_fields.length > 0 && <p>Required fields: {policy.required_fields.join(", ")}</p>}
      <label className="block">Rule text<textarea required minLength={20} maxLength={6000} rows={4} disabled={busy || uncertain} value={policy.text} onChange={event => { setPolicy({ ...policy, text: event.target.value }); setConfirmed(false); }} className="mt-1 w-full rounded-lg border bg-transparent p-2" /></label>
      <p className="text-xs text-gray-500">The displayed action and required-field list define the deterministic checks. Prose does not add other executable conditions. Existing policy IDs cannot be replaced by this screen.</p>
      <label className="flex items-start gap-2"><input type="checkbox" disabled={busy || uncertain} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I reviewed this governing rule and want to publish it to RAG.</label>
      <Button type="submit" disabled={!confirmed || busy || uncertain || !available}>{busy ? "Publishing policy…" : "Publish reviewed policy"}</Button>
    </form>}
    {receipt && <p role="status" className="text-sm text-emerald-700">Indexed · {receipt.policy_id} · v{receipt.version}. No ERP operation was performed.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {uncertain && <div className="space-y-2"><p className="text-xs text-amber-700">Publication is locked because its outcome is unconfirmed. Check for this exact indexed rule; this does not submit it again.</p><Button type="button" variant="secondary" disabled={busy} onClick={reconcile}>{busy ? "Checking saved policy…" : "Check publication status"}</Button></div>}
    {policies.length > 0 && <details><summary className="cursor-pointer text-sm font-medium">Current indexed record policies · {policies.length}</summary><ul className="mt-3 space-y-2 text-sm">{policies.map(item => <li key={`${item.policy_id}:${item.version}`}>{item.title} · {item.policy_id} · v{item.version}</li>)}</ul></details>}
  </section>;
}
