import { Icon } from "@iconify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import RegistryBulkImportPanel from "../../components/registry/RegistryBulkImportPanel";
import RegistryGenerationContextViewer from "../../components/registry/RegistryGenerationContextViewer";
import RegistryStatusBanner from "../../components/registry/RegistryStatusBanner";
import { ErrorState, EmptyState, LoadingState } from "../../components/shared/ResourceState";
import DataTable from "../../components/shared/tables/DataTable";
import Button from "../../components/shared/ui/Button";
import Tabs from "../../components/shared/ui/Tabs";
import { useNotifications } from "../../context/NotificationContext";
import { registryService } from "../../services/registry.service";
import { semanticService } from "../../services/semantic.service";
import { apiErrorMessage } from "../../services/api";
import { usePermissions } from "../../hooks/usePermissions";

const TABS = [
  { id: "tools", label: "Tools" },
  { id: "rules", label: "Rules" },
];

const NEW_TOOL = {
  tool_id: "TOOL-NEW-001",
  name: "module.action",
  display_name: "New Tool",
  module: "general",
  status: "active_mcp_schema_present",
  description: "Describe the tool capability.",
  business_capability: "Workflow operation",
  endpoint: "/tools/execute",
  http_method: "POST",
  mcp_tool_name: "module.action",
  input_schema: { type: "object", properties: {} },
  required_parameters: [],
  optional_parameters: [],
  allowed_roles: ["Platform Admin"],
  risk_level: "low",
  is_read_only: false,
  side_effects: [],
  preconditions: [],
  postconditions: [],
  failure_modes: [],
  validator_checks: ["tool_exists", "parameters_present"],
  prompt_usage_guidance: "",
  semantic_search_keywords: [],
  semantic_search_description: "",
  execution_notes: "",
  current_gaps: [],
};

const NEW_RULE = {
  rule_id: "RULE-NEW-001",
  rule_name: "New policy rule",
  rule_type: "policy",
  domain: "global",
  description: "Describe the policy requirement.",
  applies_to_tools: [],
  applies_to_roles: [],
  condition: { type: "parameter", parameter: "", operator: "exists", value: null },
  enforcement_action: "block",
  severity: "medium",
  validator_message: "Policy requirement was not met.",
  llm_prompt_instruction: "Follow this policy when generating workflows.",
  healing_guidance: "Correct the affected workflow step.",
  bpi_alignment: [],
  audit_fields_required: [],
  enabled: true,
};

const pretty = (value) => JSON.stringify(value, null, 2);

function RegistryPage({ initialKind = "tools" }) {
  const [kind, setKind] = useState(initialKind);
  const [selected, setSelected] = useState(null);
  const [editor, setEditor] = useState(null);
  const [draft, setDraft] = useState("");
  const [parseError, setParseError] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const { has } = usePermissions();
  const canWrite = has("registry:write");
  const query = useQuery({ queryKey: ["admin-registry"], queryFn: registryService.load });

  const items = query.data?.[kind] ?? [];
  const columns = useMemo(
    () => [
      { key: "name", label: kind === "tools" ? "Tool" : "Rule" },
      { key: "scope", label: kind === "tools" ? "Module" : "Domain" },
      { key: "state", label: "State" },
      { key: "actions", label: "Actions" },
    ],
    [kind]
  );
  const rows = items.map((item) => ({
    ...item,
    id: kind === "tools" ? item.tool_id : item.rule_id,
  }));

  const rebuild = async () => {
    try {
      await semanticService.rebuild();
      notify("Semantic index rebuild started.", "success");
    } catch (error) {
      notify(apiErrorMessage(error, "Semantic rebuild could not be started."), "error");
    }
  };

  const mutation = useMutation({
    mutationFn: ({ value }) =>
      editor?.id
        ? registryService.update(kind, editor.id, value)
        : registryService.create(kind, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-registry"] });
      await queryClient.invalidateQueries({ queryKey: ["registry-status"] });
      setEditor(null);
      setDraft("");
      notify("Registry saved. Semantic search may need a rebuild.", "success", {
        label: "Rebuild index",
        onClick: rebuild,
      });
    },
    onError: (error) => notify(apiErrorMessage(error, "Registry change failed."), "error"),
  });

  const openCreate = () => {
    setEditor({ id: null });
    setDraft(pretty(kind === "tools" ? NEW_TOOL : NEW_RULE));
    setParseError("");
  };

  const openEdit = (item) => {
    setEditor({ id: kind === "tools" ? item.tool_id : item.rule_id });
    setDraft(pretty(item));
    setParseError("");
  };

  const save = () => {
    try {
      const value = JSON.parse(draft);
      setParseError("");
      mutation.mutate({ value });
    } catch {
      setParseError("The registry definition is not valid JSON. Correct the document and try again.");
    }
  };

  if (query.isLoading) return <LoadingState label="Loading registry…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;

  return (
    <div className="space-y-6 pb-10">
      <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Runtime governance</p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Registry</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Manage the JSON-backed tool schemas and policy rules used by the deterministic gate.
          </p>
        </div>
        {canWrite ? <Button onClick={openCreate}>
          <Icon icon="mdi:plus" className="h-4 w-4" /> Add {kind === "tools" ? "tool" : "rule"}
        </Button> : <span className="rounded-full border border-gray-200 px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-500 dark:border-gray-800">Read only</span>}
      </section>

      <RegistryStatusBanner />

      <Tabs
        tabs={TABS}
        active={kind}
        onChange={(next) => {
          setKind(next);
          navigate(`/registry/${next}`);
          setSelected(null);
          setEditor(null);
          setParseError("");
        }}
      />

      <RegistryBulkImportPanel kind={kind} />

      {editor ? (
        <section className="surface-panel rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="section-title">{editor.id ? "Edit" : "Add"} {kind === "tools" ? "tool schema" : "policy rule"}</h2>
              <p className="mt-1 text-xs text-gray-500">Strict JSON validation runs again on the server before the snapshot changes.</p>
            </div>
            <Button variant="ghost" onClick={() => setEditor(null)}>Close</Button>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck="false"
            className="mt-4 min-h-[28rem] w-full rounded-xl border border-gray-300 bg-gray-950 p-4 font-mono text-xs leading-6 text-gray-100 outline-none focus:border-primary dark:border-gray-700"
            aria-label={`${kind} JSON`}
          />
          {parseError ? <p className="mt-3 text-sm font-semibold text-red-600">{parseError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditor(null)}>Cancel</Button>
            <Button onClick={save} disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Validate & save"}</Button>
          </div>
        </section>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          {rows.length === 0 ? (
            <EmptyState title={`No ${kind} registered`} description="Add the first validated JSON definition." />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              renderCell={(row, column) => {
                if (column.key === "name") return <><p className="font-bold text-gray-950 dark:text-white">{kind === "tools" ? row.display_name || row.name : row.rule_name}</p><p className="font-mono text-[10px] text-gray-500">{row.id}</p></>;
                if (column.key === "scope") return kind === "tools" ? row.module : row.domain;
                if (column.key === "state") return kind === "tools" ? row.status : row.enabled ? "Enabled" : "Disabled";
                return <div className="flex gap-2"><Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setSelected(row)}>View</Button>{canWrite ? <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => openEdit(row)}>Edit</Button> : null}</div>;
              }}
            />
          )}
        </div>

        <aside className="surface-panel rounded-2xl p-5">
          <h2 className="section-title">Definition detail</h2>
          {selected ? (
            <pre className="mt-4 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-gray-950 p-4 font-mono text-[11px] leading-5 text-gray-200">{pretty(selected)}</pre>
          ) : (
            <p className="mt-3 text-sm leading-6 text-gray-500">Select View to inspect the complete schema or rule before editing.</p>
          )}
        </aside>
      </section>

      <RegistryGenerationContextViewer />
    </div>
  );
}

export default RegistryPage;
