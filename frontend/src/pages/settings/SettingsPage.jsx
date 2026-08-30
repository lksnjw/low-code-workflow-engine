import { useState } from "react";
import Card from "../../components/shared/ui/Card";
import Toggle from "../../components/shared/ui/Toggle";
import ApiKeyCard from "../../components/settings/ApiKeyCard";
import IntegrationCard from "../../components/settings/IntegrationCard";
import LlmModelSelector from "../../components/settings/LlmModelSelector";
import WebhookForm from "../../components/settings/WebhookForm";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useSettings } from "../../hooks/useSettings";
import { useNotifications } from "../../context/NotificationContext";
import { settingsService } from "../../services/settings.service";

/*******************************************************************************
 * Function: SettingsPage
 *
 * Performs the Settings Page operation on page for the SettingsPage module.
 ******************************************************************************/
function SettingsPage({ view = "general" }) {
  const { data, loading, error, reload } = useSettings();
  if (loading) return <LoadingState label="Loading platform settings…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const settings = data?.settings || { general: {}, llm: {}, rbac: {} };

  const headings = {
    general: ["General Settings", "Effective platform values and API credentials returned by the settings service."],
    integrations: ["Integrations", "Configured integration records and webhook delivery endpoints."],
    llm: ["LLM Policy", "The environment fallback used when no active runtime provider is configured."],
  };
  const [title, description] = headings[view] || headings.general;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
      </div>

      {view === "general" ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <PolicyCheckerCard enabled={settings.rbac?.enabled === true} onChanged={reload} />
            <SettingsValues title="General runtime" values={settings.general} />
          </div>
          <ApiKeyCard keys={data?.apiKeys || []} />
        </section>
      ) : null}

      {view === "integrations" ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            {(data?.integrations || []).length === 0 ? (
              <EmptyState title="No integrations" description="Create integrations through the integration API." />
            ) : (
              data.integrations.map((integration) => (
                <IntegrationCard key={integration.id} integration={integration} />
              ))
            )}
          </div>
          <Card>
            <h2 className="section-title mb-5">Webhook Endpoints</h2>
            <WebhookForm onCreated={reload} />
            <div className="mt-5 space-y-2">
              {(data?.webhooks || []).length === 0 ? (
                <EmptyState title="No webhooks" description="Add a delivery endpoint for explicit webhook tests." />
              ) : (
                data.webhooks.map((webhook) => (
                  <div key={webhook.id} className="rounded-xl bg-backgroundLight p-3 text-sm dark:bg-darkBackgroundVery">
                    <p className="font-bold">{webhook.name}</p>
                    <p className="mt-1 break-all text-gray-500">{webhook.url}</p>
                  </div>
                ))
              )}
            </div>
          </Card>
        </section>
      ) : null}

      {view === "llm" ? (
        <Card>
          <h2 className="section-title">LLM Environment Fallback</h2>
          <div className="mt-5">
            <LlmModelSelector provider={settings.llm?.provider} model={settings.llm?.model} />
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Runtime provider configuration is managed on the Providers route.
          </p>
          <div className="mt-6">
            <SettingsValues title="Effective LLM values" values={settings.llm} embedded />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/*******************************************************************************
 * Function: PolicyCheckerCard
 *
 * Toggles the runtime Policy Checker (state.settings.rbac.enabled) — when on,
 * chat, workflow generation, and workflow runs are gated by role/ownership
 * checks and the ERP Bridge's policy-gate tools; when off, everything is
 * allowed through. Stored in the database, not hardcoded in source.
 ******************************************************************************/
function PolicyCheckerCard({ enabled, onChanged }) {
  const [saving, setSaving] = useState(false);
  const { notify } = useNotifications();

  const handleToggle = async (next) => {
    setSaving(true);
    try {
      await settingsService.update({ rbac: { enabled: next } });
      await onChanged?.();
      notify(next ? "Policy checker turned on." : "Policy checker turned off.", "success");
    } catch (error) {
      notify(error?.response?.data?.message || "Could not update the policy checker.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="section-title">Policy Checker</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-gray-500 dark:text-gray-400">
            When on, chat requests, workflow generation, and workflow runs are checked against role
            permissions and your ERP Bridge&apos;s policy rules before they proceed. When off, every
            request is allowed through without a policy check.
          </p>
        </div>
        <Toggle checked={enabled} onChange={saving ? undefined : handleToggle} label={saving ? "Saving…" : enabled ? "On" : "Off"} />
      </div>
    </Card>
  );
}

/*******************************************************************************
 * Function: SettingsValues
 *
 * Performs the Settings Values operation on values for the SettingsPage module.
 ******************************************************************************/
function SettingsValues({ title, values = {}, embedded = false }) {
  const entries = Object.entries(values || {});
  const content = (
    <>
      <h2 className="section-title">{title}</h2>
      {entries.length === 0 ? (
        <div className="mt-5">
          <EmptyState title="No values configured" description="The backend returned no effective values for this section." />
        </div>
      ) : (
        <dl className="mt-5 space-y-3 text-sm">
          {entries.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-4 border-b border-gray-100 pb-3 last:border-0 dark:border-gray-800">
              <dt className="text-gray-500">{key}</dt>
              <dd className="break-all text-right font-semibold text-gray-900 dark:text-white">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
  return embedded ? <section>{content}</section> : <Card>{content}</Card>;
}

export default SettingsPage;
