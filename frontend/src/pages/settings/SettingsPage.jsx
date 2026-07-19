import Card from "../../components/shared/ui/Card";
import ApiKeyCard from "../../components/settings/ApiKeyCard";
import IntegrationCard from "../../components/settings/IntegrationCard";
import LlmModelSelector from "../../components/settings/LlmModelSelector";
import SettingsNav from "../../components/settings/SettingsNav";
import WebhookForm from "../../components/settings/WebhookForm";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useSettings } from "../../hooks/useSettings";

function SettingsPage() {
  const { data, loading, error, reload } = useSettings();
  if (loading) return <LoadingState label="Loading platform settings…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const settings = data?.settings || { general: {}, llm: {}, rbac: {} };
  return <div className="space-y-6"><div><h1 className="page-heading text-gray-950 dark:text-white">Platform Settings</h1><p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">Runtime-owned values are displayed from backend configuration; business records come from the API.</p></div><SettingsNav />
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]"><div className="space-y-4"><Card><h2 className="section-title">LLM Environment Fallback</h2><div className="mt-5"><LlmModelSelector provider={settings.llm?.provider} model={settings.llm?.model} /></div><p className="mt-3 text-xs text-gray-500">This environment configuration is used only when no runtime provider is configured in Models.</p></Card><Card><h2 className="section-title">RBAC Runtime</h2><dl className="mt-5 space-y-3 text-sm">{Object.entries(settings.rbac || {}).map(([key, value]) => <div key={key} className="flex justify-between gap-4"><dt className="text-gray-500">{key}</dt><dd className="font-semibold text-gray-900 dark:text-white">{String(value)}</dd></div>)}</dl></Card><Card><h2 className="section-title mb-5">Webhook Endpoints</h2><WebhookForm onCreated={reload} /><div className="mt-5 space-y-2">{(data?.webhooks || []).map((webhook) => <div key={webhook.id} className="rounded-xl bg-backgroundLight p-3 text-sm dark:bg-darkBackgroundVery"><p className="font-bold">{webhook.name}</p><p className="mt-1 break-all text-gray-500">{webhook.url}</p></div>)}</div></Card></div>
      <div className="space-y-4"><ApiKeyCard keys={data?.apiKeys || []} /><div className="grid gap-4">{(data?.integrations || []).length === 0 ? <EmptyState title="No integrations" description="Create integrations through the integration API." /> : data.integrations.map((integration) => <IntegrationCard key={integration.id} integration={integration} />)}</div></div></section>
  </div>;
}

export default SettingsPage;
