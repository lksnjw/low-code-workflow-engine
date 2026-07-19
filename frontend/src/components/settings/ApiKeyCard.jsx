import Card from "../shared/ui/Card";

function ApiKeyCard({ keys = [] }) {
  return <Card><h2 className="section-title">API Keys</h2><div className="mt-4 space-y-2">{keys.length === 0 ? <p className="text-sm text-gray-500">No API keys created.</p> : keys.map((key) => <div key={key.id} className="rounded-xl bg-backgroundLight p-3 dark:bg-darkBackgroundVery"><p className="text-sm font-semibold text-gray-800 dark:text-gray-200">{key.name}</p><code className="mt-1 block text-xs text-gray-500">{key.maskedKey}</code></div>)}</div></Card>;
}

export default ApiKeyCard;
