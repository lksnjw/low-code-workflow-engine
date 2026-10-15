import { useState } from "react";
import Card from "../shared/ui/Card";
import Toggle from "../shared/ui/Toggle";
import { useNotifications } from "../../context/NotificationContext";
import { settingsService } from "../../services/settings.service";

/** Two independent, persisted preflight switches; never runtime approval. */
export default function PolicyChecksPanel({ rbac = {}, onChanged }) {
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");
  const { notify } = useNotifications();
  const remote = rbac.enabled === true, local = rbac.localPolicyAgentEnabled === true;
  const toggle = async (field, next) => {
    if (saving) return;
    setSaving(field); setError("");
    try {
      const saved = await settingsService.update({ rbac: { [field]: next } });
      if (saved?.rbac?.[field] !== next) throw new Error("Policy setting was not confirmed. Reload settings before trying again.");
      const refreshed = await onChanged?.();
      if (refreshed?.error) throw new Error("Setting saved, but the refresh failed. Reload settings to confirm the current value.");
      notify("Policy setting saved.", "success");
    } catch (failure) {
      const message = failure?.response?.data?.message || failure?.message || "Could not save policy settings. Reload before trying again.";
      setError(message); notify(message, "error");
    } finally { setSaving(null); }
  };
  const mode = remote && local ? "Backend RAG first (up to 10 seconds); local JSON/model only if the checker is unavailable."
    : remote ? "Backend RAG only. If the checker is unavailable, the request is blocked."
    : local ? "Local JSON/model only, using your selected model."
    : "Additional policy checks are off.";
  return <Card>
    <h2 className="section-title">Policy checks</h2>
    <a href="/settings/rag-policy" className="mt-2 inline-block text-sm text-primary hover:underline">Open RAG policy console</a>
    <fieldset disabled={Boolean(saving)} className="mt-4 space-y-5 disabled:opacity-70">
      {[
        ["enabled", "RAG policy checker", remote, "The backend checks requests against the configured RAG service. Its key stays on the server. Older deployments without a direct RAG connection retain their reviewed ERPBridge adapter."],
        ["localPolicyAgentEnabled", "Local JSON policy agent", local, "Use your backend-configured JSON policy with the selected model for an allow, deny or review decision. JSON files are configured on the backend, not imported here."],
      ].map(([field, title, checked, description]) => <div key={field} role="group" aria-label={title} className="flex items-start justify-between gap-4">
        <div className="min-w-0"><h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3><p id={`policy-${field}-description`} className="mt-1 max-w-md text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p></div>
        <Toggle checked={checked} onChange={next => toggle(field, next)} ariaLabel={title} describedBy={`policy-${field}-description`} disabled={Boolean(saving)} label={saving === field ? "Saving…" : checked ? "On" : "Off"} />
      </div>)}
    </fieldset>
    <p role="status" className="mt-4 text-sm text-gray-600 dark:text-gray-300">{mode}</p>
    <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">A remote denial or review requirement is never overridden. Login, role permissions, validation and required runtime approvals remain enforced in every mode.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
  </Card>;
}
