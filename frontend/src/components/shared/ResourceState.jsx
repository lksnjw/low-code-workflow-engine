import Button from "./ui/Button";

export function LoadingState({ label = "Loading data…" }) {
  return <div className="surface-panel rounded-2xl p-8 text-sm text-gray-500">{label}</div>;
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
      <p className="font-bold">Could not load this data</p>
      <p className="mt-2">{error?.response?.data?.message || error?.message || "Request failed"}</p>
      {onRetry ? <Button className="mt-4" variant="secondary" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

export function EmptyState({ title, description }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-10 text-center dark:border-gray-700">
      <p className="font-bold text-gray-900 dark:text-white">{title}</p>
      {description ? <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{description}</p> : null}
    </div>
  );
}
