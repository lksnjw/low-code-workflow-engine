function LlmModelSelector({ provider, model }) {
  return <div className="rounded-xl border border-gray-200 bg-backgroundLight p-4 dark:border-gray-800 dark:bg-darkBackgroundVery"><p className="text-xs font-bold uppercase text-gray-500">Configured provider</p><p className="mt-2 font-bold text-gray-950 dark:text-white">{provider || "Not configured"}</p><p className="mt-1 text-sm text-gray-500">{model || "No model selected"}</p></div>;
}

export default LlmModelSelector;
