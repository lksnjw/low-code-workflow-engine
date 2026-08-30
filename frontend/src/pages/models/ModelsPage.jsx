import { Icon } from "@iconify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorState, EmptyState, LoadingState } from "../../components/shared/ResourceState";
import DataTable from "../../components/shared/tables/DataTable";
import Button from "../../components/shared/ui/Button";
import { useNotifications } from "../../context/NotificationContext";
import { apiErrorMessage } from "../../services/api";
import { settingsService } from "../../services/settings.service";

const EMPTY_FORM = { name: "", type: "gemini", baseUrl: "", model: "", temperature: 0, apiKey: "", additionalModels: [] };
const INPUT_CLASS = "w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackgroundVery dark:text-white";
const COLUMNS = [
  { key: "name", label: "Provider" },
  { key: "model", label: "Model" },
  { key: "credential", label: "Credential" },
  { key: "actions", label: "Actions" },
];

/*******************************************************************************
 * Function: ModelsPage
 *
 * Performs the Models Page operation on page for the ModelsPage module.
 ******************************************************************************/
function ModelsPage() {
  const [editor, setEditor] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [modelInput, setModelInput] = useState("");
  const [testingId, setTestingId] = useState("");
  const [testResults, setTestResults] = useState({});
  const { notify } = useNotifications();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["providers"], queryFn: settingsService.providers });

/*******************************************************************************
 * Function: refresh
 *
 * Refreshes the application for the ModelsPage module.
 ******************************************************************************/
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["providers"] });
/*******************************************************************************
 * Function: saveMutation
 *
 * Saves mutation for the ModelsPage module.
 ******************************************************************************/
  const saveMutation = useMutation({
    mutationFn: (payload) =>
      editor?.id
        ? settingsService.updateProvider(editor.id, payload)
        : settingsService.createProvider(payload),
    onSuccess: async () => {
      await refresh();
      setEditor(null);
      setForm(EMPTY_FORM);
      notify("Provider configuration saved.", "success");
    },
    onError: (error) => notify(apiErrorMessage(error, "Provider configuration failed."), "error"),
  });

/*******************************************************************************
 * Function: openCreate
 *
 * Performs the open Create operation on create for the ModelsPage module.
 ******************************************************************************/
  const openCreate = () => {
    setEditor({ id: null });
    setForm(EMPTY_FORM);
    setModelInput("");
  };

/*******************************************************************************
 * Function: openEdit
 *
 * Performs the open Edit operation on edit for the ModelsPage module.
 ******************************************************************************/
  const openEdit = (provider) => {
    setEditor(provider);
    setModelInput("");
    setForm({
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl || "",
      model: provider.model,
      temperature: provider.temperature ?? 0,
      apiKey: "",
      additionalModels: Array.isArray(provider.additionalModels) ? [...provider.additionalModels] : [],
    });
  };

/*******************************************************************************
 * Function: updateField
 *
 * Updates field for the ModelsPage module.
 ******************************************************************************/
  const updateField = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: name === "temperature" ? Number(value) : value }));
  };

  const addSelectableModel = () => {
    const id = modelInput.trim();
    if (!id || form.additionalModels.includes(id)) return;
    setForm((current) => ({ ...current, additionalModels: [...current.additionalModels, id] }));
    setModelInput("");
  };

  const removeSelectableModel = (id) => {
    setForm((current) => ({ ...current, additionalModels: current.additionalModels.filter((m) => m !== id) }));
  };

/*******************************************************************************
 * Function: save
 *
 * Saves the application for the ModelsPage module.
 ******************************************************************************/
  const save = (event) => {
    event.preventDefault();
    saveMutation.mutate(form);
  };

/*******************************************************************************
 * Function: activate
 *
 * Performs the activate operation on the application for the ModelsPage module.
 ******************************************************************************/
  const activate = async (provider) => {
    try {
      await settingsService.activateProvider(provider.id);
      await refresh();
      notify(`${provider.name} is now active.`, "success");
    } catch (error) {
      notify(apiErrorMessage(error, "Provider activation failed."), "error");
    }
  };

/*******************************************************************************
 * Function: testConnection
 *
 * Performs the test Connection operation on connection for the ModelsPage module.
 ******************************************************************************/
  const testConnection = async (provider) => {
    setTestingId(provider.id);
    try {
      const result = await settingsService.testProvider(provider.id);
      setTestResults((current) => ({ ...current, [provider.id]: result.message }));
      notify(result.message, result.ok ? "success" : "error");
    } catch (error) {
      const message = apiErrorMessage(error, "Provider connection test failed.");
      setTestResults((current) => ({ ...current, [provider.id]: message }));
      notify(message, "error");
    } finally {
      setTestingId("");
    }
  };

  if (query.isLoading) return <LoadingState label="Loading model providers…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  const providers = query.data ?? [];

  return (
    <div className="space-y-6 pb-10">
      <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Generation runtime</p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Models</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Configure Gemini, Ollama, or OpenAI-compatible providers. Credentials are write-only.
          </p>
        </div>
        <Button onClick={openCreate}><Icon icon="mdi:plus" className="h-4 w-4" /> Add provider</Button>
      </section>

      {editor ? (
        <form onSubmit={save} className="surface-panel rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="section-title">{editor.id ? "Edit provider" : "Add provider"}</h2>
              <p className="mt-1 text-xs text-gray-500">Only the safe credential preview is returned after save.</p>
            </div>
            <Button variant="ghost" onClick={() => setEditor(null)}>Close</Button>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="Name"><input required name="name" value={form.name} onChange={updateField} className={INPUT_CLASS} placeholder="Production Gemini" /></Field>
            <Field label="Provider type"><select name="type" value={form.type} onChange={updateField} className={INPUT_CLASS}><option value="gemini">Gemini</option><option value="ollama">Ollama</option><option value="openai_compatible">OpenAI compatible</option></select></Field>
            <Field label="Base URL"><input name="baseUrl" value={form.baseUrl} onChange={updateField} className={INPUT_CLASS} placeholder={form.type === "gemini" ? "Optional Gemini API base URL" : "https://provider.example/v1"} /></Field>
            <Field label="Model"><input required name="model" value={form.model} onChange={updateField} className={INPUT_CLASS} placeholder="Model identifier" /></Field>
            <Field label="Temperature" hint="Defaults to 0 for reproducible generation."><input required name="temperature" type="number" min="0" step="0.1" value={form.temperature} onChange={updateField} className={INPUT_CLASS} /></Field>
            <Field label="API key" hint={editor.id ? `Leave blank to retain ${editor.keyPreview || "the stored credential"}.` : form.type === "ollama" ? "Optional for Ollama." : "Required and never returned."}>
              <input name="apiKey" type="password" value={form.apiKey} onChange={updateField} className={INPUT_CLASS} placeholder="Write-only credential" autoComplete="new-password" />
            </Field>
          </div>

          {/* Selectable models — extra model IDs shown in the chat model selector */}
          <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Selectable models</p>
            <p className="mt-1 text-xs text-gray-400">Add model IDs that users can pick in the chat interface. These use the same provider credentials.</p>
            <div className="mt-3 flex gap-2">
              <input
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSelectableModel(); } }}
                placeholder="e.g. deepseek/deepseek-v3-flash"
                className={INPUT_CLASS + " flex-1"}
              />
              <Button type="button" variant="secondary" onClick={addSelectableModel}>Add</Button>
            </div>
            {form.additionalModels.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {form.additionalModels.map((id) => (
                  <li key={id} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-darkBackground">
                    <span className="font-mono text-xs text-gray-700 dark:text-gray-200">{id}</span>
                    <button type="button" onClick={() => removeSelectableModel(id)} className="ml-3 text-gray-400 hover:text-red-500">
                      <Icon icon="mdi:close" className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={() => setEditor(null)}>Cancel</Button><Button type="submit" disabled={saveMutation.isPending}>{saveMutation.isPending ? "Saving…" : "Save provider"}</Button></div>
        </form>
      ) : null}

      {providers.length === 0 ? (
        <EmptyState title="No runtime providers" description="The environment provider remains the fallback until the first provider is added." />
      ) : (
        <DataTable
          columns={COLUMNS}
          rows={providers}
          renderCell={(provider, column) => {
            if (column.key === "name") return <><div className="flex items-center gap-2"><p className="font-bold text-gray-950 dark:text-white">{provider.name}</p>{provider.active ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold uppercase text-green-700">Active</span> : null}</div><p className="mt-1 text-xs text-gray-500">{provider.type}</p></>;
            if (column.key === "model") return <><p className="font-semibold">{provider.model}</p><p className="mt-1 max-w-xs truncate text-xs text-gray-500">{provider.baseUrl || "Default provider endpoint"}</p></>;
            if (column.key === "credential") return provider.keyPreview || "Not required";
            return <div className="flex flex-wrap gap-2"><Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => openEdit(provider)}>Edit</Button><Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={provider.active} onClick={() => activate(provider)}>{provider.active ? "Active" : "Activate"}</Button><Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={testingId === provider.id} onClick={() => testConnection(provider)}>{testingId === provider.id ? "Testing…" : "Test connection"}</Button>{testResults[provider.id] ? <span className="w-full text-xs text-gray-500">{testResults[provider.id]}</span> : null}</div>;
          }}
        />
      )}
    </div>
  );
}

/*******************************************************************************
 * Function: Field
 *
 * Performs the Field operation on the application for the ModelsPage module.
 ******************************************************************************/
function Field({ label, hint, children }) {
  return (
    <label className="text-sm font-semibold text-gray-700 dark:text-gray-200">
      {label}
      <span className="mt-2 block">{children}</span>
      {hint ? <span className="mt-1 block text-xs font-normal text-gray-500">{hint}</span> : null}
    </label>
  );
}

export default ModelsPage;
