import { Icon } from "@iconify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import usePermissions from "../../hooks/usePermissions";
import { apiErrorMessage } from "../../services/api";
import { registryService } from "../../services/registry.service";
import Button from "../shared/ui/Button";

function RegistryBulkImportPanel({ kind }) {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("[]");
  const [allowUpdates, setAllowUpdates] = useState(false);
  const [parseError, setParseError] = useState("");
  const [result, setResult] = useState(null);
  const canImport = has("settings:manage");

  const mutation = useMutation({
    mutationFn: (values) => registryService.bulkImport(kind, values, allowUpdates),
    onSuccess: async (value) => {
      setResult(value);
      setParseError("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-registry"] }),
        queryClient.invalidateQueries({ queryKey: ["registry-status"] }),
        queryClient.invalidateQueries({ queryKey: ["registry-context"] }),
        queryClient.invalidateQueries({ queryKey: ["registry-context-history"] }),
      ]);
    },
    onError: (error) => {
      const report = error?.response?.data?.data;
      if (report?.errors?.length) {
        setResult(report);
        setParseError("");
        return;
      }
      setResult(null);
      setParseError(apiErrorMessage(error, "The registry import could not be completed."));
    },
  });

  if (!canImport) return null;

  const importBatch = () => {
    try {
      const values = JSON.parse(draft);
      if (!Array.isArray(values) || values.length === 0) {
        setParseError("Paste or upload a non-empty JSON array.");
        setResult(null);
        return;
      }
      setParseError("");
      setResult(null);
      mutation.mutate(values);
    } catch {
      setParseError("The import is not valid JSON. Correct the array and try again.");
      setResult(null);
    }
  };

  const loadFile = async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    setDraft(await file.text());
    setParseError("");
    setResult(null);
  };

  return (
    <section className="surface-panel overflow-hidden rounded-2xl" aria-label="Registry bulk import">
      <div className="border-b border-gray-100 px-5 py-4 dark:border-gray-800">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div>
            <h2 className="section-title">Import {kind}</h2>
            <p className="mt-1 text-xs leading-5 text-gray-500">
              Every entry is validated first. One failure rejects the entire batch.
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-xs font-bold text-gray-700 transition hover:border-primary hover:text-primary dark:border-gray-700 dark:text-gray-200">
            <Icon icon="mdi:file-upload-outline" className="h-4 w-4" />
            Upload JSON
            <input type="file" accept="application/json,.json" className="sr-only" onChange={loadFile} />
          </label>
        </div>
      </div>

      <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck="false"
            aria-label={`${kind} import JSON`}
            className="min-h-56 w-full rounded-xl border border-gray-300 bg-gray-950 p-4 font-mono text-xs leading-6 text-gray-100 outline-none focus:border-primary dark:border-gray-700"
          />
          <div className="mt-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <label className="flex items-start gap-2 text-xs leading-5 text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={allowUpdates}
                onChange={(event) => setAllowUpdates(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              Explicitly allow matching IDs to update existing entries
            </label>
            <Button onClick={importBatch} disabled={mutation.isPending}>
              <Icon icon="mdi:database-import-outline" className="h-4 w-4" />
              {mutation.isPending ? "Validating..." : "Validate & import"}
            </Button>
          </div>
          {parseError ? <p role="alert" className="mt-3 text-sm font-semibold text-red-600">{parseError}</p> : null}
        </div>

        <ImportResult result={result} />
      </div>
    </section>
  );
}

function ImportResult({ result }) {
  if (!result) {
    return (
      <aside className="border-l-0 border-gray-100 xl:border-l xl:pl-5 dark:border-gray-800">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-gray-400">Import result</p>
        <p className="mt-3 text-sm leading-6 text-gray-500">Validation results will identify each rejected index and ID.</p>
      </aside>
    );
  }
  const errors = result.errors || [];
  return (
    <aside className="border-l-0 border-gray-100 xl:border-l xl:pl-5 dark:border-gray-800" aria-live="polite">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-gray-400">Import result</p>
      <p className={`mt-3 text-lg font-bold ${errors.length ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`}>
        {result.count || 0} imported
      </p>
      {errors.length ? (
        <div className="mt-4 space-y-3">
          <p className="text-xs font-semibold text-red-700 dark:text-red-300">Nothing was applied.</p>
          <ul className="space-y-2">
            {errors.map((error, index) => (
              <li key={`${error.index}-${error.id || index}`} className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-800 dark:bg-red-950/30 dark:text-red-200">
                <span className="font-bold">Index {error.index}{error.id ? ` · ${error.id}` : ""}</span>
                <span className="block">{error.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-xs leading-5 text-gray-500">The JSON file, live snapshot, registry hash, and generation context were updated together.</p>
      )}
    </aside>
  );
}

export default RegistryBulkImportPanel;
