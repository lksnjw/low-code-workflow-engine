import { Icon } from "@iconify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import RegistryStatusBanner from "../../components/registry/RegistryStatusBanner";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import Button from "../../components/shared/ui/Button";
import { apiErrorMessage } from "../../services/api";
import { registryService } from "../../services/registry.service";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const REVIEW_GROUPS = [
  ["added", "Added", "text-emerald-700 dark:text-emerald-300"],
  ["updated", "Updated", "text-amber-700 dark:text-amber-300"],
  ["unchanged", "Unchanged", "text-gray-600 dark:text-gray-300"],
  ["rejected", "Rejected", "text-red-700 dark:text-red-300"],
  ["orphaned", "Orphaned", "text-red-700 dark:text-red-300"],
];

/*******************************************************************************
 * Function: WizardSteps
 *
 * Performs the Wizard Steps operation on steps for the RegistryImportPage module.
 ******************************************************************************/
function WizardSteps({ active }) {
  return (
    <ol className="grid gap-3 sm:grid-cols-3" aria-label="Import progress">
      {["Upload", "Review", "Commit"].map((label, index) => {
        const number = index + 1;
        const current = number === active;
        const complete = number < active;
        return (
          <li
            key={label}
            className={`rounded-2xl border px-4 py-3 ${
              current
                ? "border-primary bg-primary/5"
                : "border-gray-200 bg-white dark:border-gray-800 dark:bg-darkBackground"
            }`}
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">
              {complete ? "Complete" : `Step ${number}`}
            </p>
            <p className={`mt-1 font-bold ${current ? "text-primary" : "text-gray-800 dark:text-gray-100"}`}>{label}</p>
          </li>
        );
      })}
    </ol>
  );
}

/*******************************************************************************
 * Function: FileDrop
 *
 * Performs the File Drop operation on drop for the RegistryImportPage module.
 ******************************************************************************/
function FileDrop({ file, onFile }) {
  const inputRef = useRef(null);
  return (
    <div
      className="rounded-3xl border-2 border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center transition-colors hover:border-primary/60 dark:border-gray-700 dark:bg-black/20"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onFile(event.dataTransfer.files?.[0] || null);
      }}
    >
      <Icon icon="mdi:file-upload-outline" className="mx-auto h-10 w-10 text-primary" />
      <p className="mt-4 font-bold text-gray-950 dark:text-white">
        {file ? file.name : "Drop a registry file here"}
      </p>
      <p className="mt-2 text-sm text-gray-500">
        JSON, YAML, or CSV for tools and rules; OpenAPI 3.0/3.1 as JSON or YAML. Maximum 10 MiB.
      </p>
      {file ? <p className="mt-2 font-mono text-xs text-gray-400">{(file.size / 1024).toFixed(1)} KiB</p> : null}
      <Button variant="secondary" className="mt-5" onClick={() => inputRef.current?.click()}>
        Choose file
      </Button>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept=".json,.yaml,.yml,.csv,application/json,text/yaml,text/csv"
        onChange={(event) => onFile(event.target.files?.[0] || null)}
      />
    </div>
  );
}

/*******************************************************************************
 * Function: ImportHistory
 *
 * Performs the Import History operation on history for the RegistryImportPage module.
 ******************************************************************************/
function ImportHistory({ query }) {
  if (query.isLoading) return <LoadingState label="Loading import history…" />;
  if (query.isError) return <ErrorState message="Import history could not be loaded." onRetry={query.refetch} />;
  if (!query.data?.length) {
    return <EmptyState title="No completed imports" description="Committed imports will appear here with their source hash and registry result." />;
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 dark:bg-black/20">
          <tr><th className="px-4 py-3">File</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3">Changes</th><th className="px-4 py-3">Registry hash</th></tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {query.data.map((entry) => (
            <tr key={entry.analysisId}>
              <td className="px-4 py-3"><p className="font-semibold text-gray-900 dark:text-white">{entry.filename}</p><p className="font-mono text-[10px] text-gray-400">{entry.fileSha256}</p></td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{entry.actorName || entry.actorId || "Platform Admin"}</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{entry.counts?.added || 0} added · {entry.counts?.updated || 0} updated</td>
              <td className="px-4 py-3 font-mono text-[10px] text-gray-500">{entry.resultingRegistryHash}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/*******************************************************************************
 * Function: ChangeList
 *
 * Performs the Change List operation on list for the RegistryImportPage module.
 ******************************************************************************/
function ChangeList({ changes }) {
  if (!changes?.length) return <span className="text-xs text-gray-400">No field changes</span>;
  return (
    <details>
      <summary className="cursor-pointer text-xs font-semibold text-primary">{changes.length} field change(s)</summary>
      <div className="mt-2 space-y-2">
        {changes.map((change) => (
          <div key={change.field} className="rounded-xl bg-gray-50 p-3 text-xs dark:bg-black/20">
            <p className="font-mono font-bold text-gray-700 dark:text-gray-200">{change.field}</p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <pre className="overflow-auto whitespace-pre-wrap break-all text-red-700 dark:text-red-300">{JSON.stringify(change.before, null, 2)}</pre>
              <pre className="overflow-auto whitespace-pre-wrap break-all text-emerald-700 dark:text-emerald-300">{JSON.stringify(change.after, null, 2)}</pre>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

/*******************************************************************************
 * Function: ReviewTable
 *
 * Performs the Review Table operation on table for the RegistryImportPage module.
 ******************************************************************************/
function ReviewTable({ name, label, tone, records, selected, onToggle }) {
  if (!records.length) {
    return (
      <section className="surface-panel rounded-2xl p-5">
        <h3 className={`font-bold ${tone}`}>{label} · 0</h3>
        <p className="mt-2 text-sm text-gray-500">No records in this category.</p>
      </section>
    );
  }
  const selectable = name === "added" || name === "updated";
  return (
    <section className="surface-panel rounded-2xl p-5">
      <h3 className={`font-bold ${tone}`}>{label} · {records.length}</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-gray-500">
            <tr>{selectable ? <th className="pb-3 pr-4">Include</th> : null}<th className="pb-3 pr-4">Record</th><th className="pb-3 pr-4">Source</th><th className="pb-3">Evidence</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {records.map((record) => (
              <tr key={record.recordId}>
                {selectable ? (
                  <td className="py-4 pr-4 align-top">
                    <input
                      type="checkbox"
                      checked={selected.has(record.recordId)}
                      onChange={() => onToggle(record.recordId)}
                      aria-label={`Include ${record.sourceId}`}
                      className="h-4 w-4 accent-primary"
                    />
                  </td>
                ) : null}
                <td className="py-4 pr-4 align-top">
                  <p className="font-semibold text-gray-900 dark:text-white">{record.sourceId || record.recordId}</p>
                  <p className="font-mono text-[10px] text-gray-400">{record.registryKind}</p>
                  {record.requiresConfirmation ? <span className="mt-2 inline-block rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Risk default requires confirmation</span> : null}
                </td>
                <td className="py-4 pr-4 align-top text-xs text-gray-500">line {record.line || "—"} · index {record.index}</td>
                <td className="py-4 align-top">
                  {record.errors?.length ? (
                    <ul className="space-y-2">
                      {record.errors.map((error, index) => (
                        <li key={`${error.field}-${index}`} className="text-xs text-red-700 dark:text-red-300">
                          <span className="font-mono font-bold">{error.field}</span>: {error.reason}
                        </li>
                      ))}
                    </ul>
                  ) : <ChangeList changes={record.changes} />}
                  {record.metadata?.response_schema ? (
                    <p className="mt-3 rounded-xl bg-blue-50 p-3 text-xs text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
                      The 2xx response schema is recorded in import history but is not enforced by the deterministic gate today.
                    </p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/*******************************************************************************
 * Function: RegistryImportPage
 *
 * Performs the Registry Import Page operation on import page for the RegistryImportPage module.
 ******************************************************************************/
function RegistryImportPage() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [kind, setKind] = useState("tools");
  const [prefix, setPrefix] = useState("");
  const [allowUpdates, setAllowUpdates] = useState(false);
  const [localError, setLocalError] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [commitResult, setCommitResult] = useState(null);
  const historyQuery = useQuery({ queryKey: ["registry-import-history"], queryFn: registryService.importHistory });

/*******************************************************************************
 * Function: analyseMutation
 *
 * Performs the analyse Mutation operation on mutation for the RegistryImportPage module.
 ******************************************************************************/
  const analyseMutation = useMutation({
    mutationFn: registryService.analyseImport,
    onSuccess: (value) => {
      setAnalysis(value);
      setSelected(new Set());
      setLocalError("");
      setStep(2);
    },
    onError: () => setLocalError("The file could not be analysed. Check its format and try again."),
  });
/*******************************************************************************
 * Function: commitMutation
 *
 * Performs the commit Mutation operation on mutation for the RegistryImportPage module.
 ******************************************************************************/
  const commitMutation = useMutation({
    mutationFn: () => registryService.commitImport(analysis.id, [...selected]),
    onSuccess: async (value) => {
      setCommitResult(value);
      setLocalError("");
      setStep(3);
      await historyQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ["registry-status"] });
    },
    onError: (error) => setLocalError(apiErrorMessage(error, "The selected records could not be committed. Review the selection and try again.")),
  });

/*******************************************************************************
 * Function: counts
 *
 * Performs the counts operation on the application for the RegistryImportPage module.
 ******************************************************************************/
  const counts = useMemo(() => {
    const preview = analysis?.preview || {};
    return Object.fromEntries(REVIEW_GROUPS.map(([name]) => [name, preview[name]?.length || 0]));
  }, [analysis]);

/*******************************************************************************
 * Function: chooseFile
 *
 * Performs the choose File operation on file for the RegistryImportPage module.
 ******************************************************************************/
  const chooseFile = (nextFile) => {
    if (nextFile && nextFile.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setLocalError("The selected file exceeds the 10 MiB limit.");
      return;
    }
    setFile(nextFile);
    setLocalError("");
  };
/*******************************************************************************
 * Function: analyse
 *
 * Performs the analyse operation on the application for the RegistryImportPage module.
 ******************************************************************************/
  const analyse = () => {
    if (!file) {
      setLocalError("Choose a registry file before continuing.");
      return;
    }
    if (kind === "openapi" && prefix.trim().split(".").filter(Boolean).length < 2) {
      setLocalError("OpenAPI imports require a namespace prefix with at least two segments, such as finance.invoice.");
      return;
    }
    analyseMutation.mutate({ file, kind, prefix, allowUpdates });
  };
/*******************************************************************************
 * Function: toggle
 *
 * Performs the toggle operation on the application for the RegistryImportPage module.
 ******************************************************************************/
  const toggle = (recordID) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(recordID)) next.delete(recordID);
      else next.add(recordID);
      return next;
    });
  };

  return (
    <div className="space-y-6 pb-12">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Registry governance</p>
        <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Bulk import</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
          Analyse organisation tool, rule, or OpenAPI files, review every deterministic diff, then commit only the records you approve.
        </p>
      </header>
      <RegistryStatusBanner />
      <WizardSteps active={step} />

      {localError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">{localError}</div>
      ) : null}

      {step === 1 ? (
        <>
          <section className="surface-panel grid gap-6 rounded-3xl p-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <FileDrop file={file} onFile={chooseFile} />
            <div className="space-y-5">
              <label className="block text-sm font-semibold text-gray-800 dark:text-gray-100">
                Source type
                <select value={kind} onChange={(event) => setKind(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 dark:border-gray-700 dark:bg-darkBackground">
                  <option value="tools">Tools</option>
                  <option value="rules">Rules</option>
                  <option value="openapi">OpenAPI 3.0 / 3.1</option>
                </select>
              </label>
              {kind === "openapi" ? (
                <label className="block text-sm font-semibold text-gray-800 dark:text-gray-100">
                  Tool namespace prefix
                  <input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="finance.invoice" className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 font-mono dark:border-gray-700 dark:bg-darkBackground" />
                </label>
              ) : null}
              {kind !== "rules" ? (
                <label className="flex items-start gap-3 text-sm text-gray-600 dark:text-gray-300">
                  <input type="checkbox" checked={allowUpdates} onChange={(event) => setAllowUpdates(event.target.checked)} className="mt-1 h-4 w-4 accent-primary" />
                  <span><strong className="block text-gray-900 dark:text-white">Allow changed active tools as updates</strong>Without this explicit marker, collisions are rejected.</span>
                </label>
              ) : null}
              <Button onClick={analyse} disabled={analyseMutation.isPending} className="w-full">
                {analyseMutation.isPending ? "Analysing six-stage pipeline…" : "Analyse file"}
              </Button>
              {analyseMutation.isPending ? <LoadingState label="Parsing, normalising, validating, and building the registry diff…" /> : null}
            </div>
          </section>
          <section>
            <h2 className="section-title mb-4">Import history</h2>
            <ImportHistory query={historyQuery} />
          </section>
        </>
      ) : null}

      {step === 2 && analysis ? (
        <>
          <section className="surface-panel rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div><h2 className="section-title">Review {analysis.filename}</h2><p className="mt-1 font-mono text-[10px] text-gray-400">{analysis.fileSha256}</p></div>
              <div className="flex flex-wrap gap-2">{REVIEW_GROUPS.map(([name, label]) => <span key={name} className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-200">{label} {counts[name]}</span>)}</div>
            </div>
            <p className="mt-4 text-sm text-gray-500">Analysis persisted no registry data. Select each added or updated record you want to commit.</p>
          </section>
          {REVIEW_GROUPS.map(([name, label, tone]) => (
            <ReviewTable key={name} name={name} label={label} tone={tone} records={analysis.preview?.[name] || []} selected={selected} onToggle={toggle} />
          ))}
          <div className="flex flex-col justify-between gap-3 sm:flex-row">
            <Button variant="secondary" onClick={() => { setStep(1); setLocalError(""); }}>Back to upload</Button>
            <Button onClick={() => commitMutation.mutate()} disabled={!selected.size || commitMutation.isPending}>
              {commitMutation.isPending ? "Restoring-safe commit in progress…" : `Commit ${selected.size} selected record(s)`}
            </Button>
          </div>
          {commitMutation.isPending ? <LoadingState label="Backing up both registries and applying the confirmed records…" /> : null}
        </>
      ) : null}

      {step === 3 && commitResult ? (
        <section className="surface-panel rounded-3xl p-8">
          <Icon icon="mdi:check-decagram" className="h-12 w-12 text-emerald-600" />
          <h2 className="mt-5 text-2xl font-bold text-gray-950 dark:text-white">Registry import committed</h2>
          <p className="mt-2 text-sm text-gray-500">{commitResult.committedRecordIds?.length || 0} confirmed record(s) were applied through the registry manager and audit-logged.</p>
          <div className="mt-6 rounded-2xl bg-gray-950 p-5 text-gray-100">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">Resulting registry hash</p>
            <p className="mt-2 break-all font-mono text-sm">{commitResult.resultingRegistryHash}</p>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={() => { setStep(1); setFile(null); setAnalysis(null); setCommitResult(null); setSelected(new Set()); }}>Import another file</Button>
            <Button variant="secondary" onClick={() => setStep(2)}>Review completed diff</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default RegistryImportPage;
