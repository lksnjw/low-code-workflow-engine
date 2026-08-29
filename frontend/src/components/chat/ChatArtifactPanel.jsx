import { useState } from "react";
import { Icon } from "@iconify/react";
import { useRoute } from "../../context/RouteContext";
import usePermissions from "../../hooks/usePermissions";
import { saveWorkflowForCanvas } from "../../utils/workflowCanvas.utils";

// ── Risk badge colours ──────────────────────────────────────────────────────
const RISK_COLORS = {
  low: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};
const METHOD_COLORS = {
  GET: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  POST: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  PATCH: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  PUT: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  DELETE: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

function Pill({ children, color = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4 ${color}`}>
      {children}
    </span>
  );
}

function SectionHeader({ icon, label, count }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon icon={icon} className="h-4 w-4 text-primary" />
      <h4 className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400">{label}</h4>
      {count !== undefined && (
        <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
          {count}
        </span>
      )}
    </div>
  );
}

// ── Collapsible wrapper ─────────────────────────────────────────────────────
function Collapsible({ title, icon, count, defaultOpen = false, children, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <Icon icon={icon} className="h-4 w-4 shrink-0 text-primary" />
        <span className="flex-1 text-xs font-bold text-gray-800 dark:text-gray-100">{title}</span>
        {badge}
        {count !== undefined && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {count}
          </span>
        )}
        <Icon
          icon={open ? "mdi:chevron-up" : "mdi:chevron-down"}
          className="h-4 w-4 text-gray-400"
        />
      </button>
      {open && <div className="border-t border-gray-100 px-3 pb-3 pt-2 dark:border-gray-800">{children}</div>}
    </div>
  );
}

// ── Tool card ───────────────────────────────────────────────────────────────
function ToolCard({ tool }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-gray-900 dark:text-white">{tool.display_name}</p>
          <p className="mt-0.5 font-mono text-[10px] text-gray-500">{tool.name}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Pill color={METHOD_COLORS[tool.http_method] ?? ""}>{tool.http_method}</Pill>
          <Pill color={RISK_COLORS[tool.risk_level]}>{tool.risk_level}</Pill>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        <Pill color="bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
          {tool.erp_system}
        </Pill>
        {tool.bpi_process_alignment?.map((b) => (
          <Pill key={b} color="bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300">
            {b}
          </Pill>
        ))}
        <Pill color="bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {(tool.score * 100).toFixed(1)}%
        </Pill>
      </div>

      {tool.current_gaps?.length > 0 && (
        <p className="mt-1.5 text-[10px] italic text-amber-600 dark:text-amber-400">
          ⚠ {tool.current_gaps[0]}
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 text-[10px] font-semibold text-primary hover:underline"
      >
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-gray-100 pt-2 dark:border-gray-800">
          <p className="text-gray-600 dark:text-gray-300">{tool.description}</p>
          <p className="font-mono text-[10px] text-gray-400">{tool.endpoint}</p>
          {tool.allowed_roles?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tool.allowed_roles.map((r) => (
                <Pill key={r} color="bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
                  {r}
                </Pill>
              ))}
            </div>
          )}
          {tool.required_parameters?.length > 0 && (
            <p className="text-gray-500">
              Required: <span className="font-semibold">{tool.required_parameters.join(", ")}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Rule card ───────────────────────────────────────────────────────────────
const RULE_TYPE_COLORS = {
  rbac: "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300",
  audit: "bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-300",
  cache_safety: "bg-cyan-50 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-300",
  execution_safety: "bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300",
  data_confidentiality: "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300",
  process_order: "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300",
};

const ACTION_ICON = {
  block: "mdi:block-helper",
  allow: "mdi:check-circle-outline",
  write_audit_log: "mdi:file-document-edit-outline",
  escalate_to_admin: "mdi:account-alert-outline",
  require_additional_tool: "mdi:tools",
};

function RuleCard({ rule }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-gray-900 dark:text-white">{rule.rule_name}</p>
          <p className="mt-0.5 text-[10px] text-gray-400">{rule.rule_id}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Pill color={RULE_TYPE_COLORS[rule.rule_type] ?? ""}>{rule.rule_type}</Pill>
          <Pill color={RISK_COLORS[rule.severity]}>{rule.severity}</Pill>
        </div>
      </div>
      <p className="mt-1.5 text-gray-600 dark:text-gray-300 line-clamp-2">{rule.description}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Icon
          icon={ACTION_ICON[rule.enforcement_action] ?? "mdi:information-outline"}
          className={`h-3.5 w-3.5 ${rule.enforcement_action === "block" ? "text-red-500" : rule.enforcement_action === "allow" ? "text-emerald-500" : "text-amber-500"}`}
        />
        <span className={`text-[10px] font-semibold ${rule.enforcement_action === "block" ? "text-red-500" : rule.enforcement_action === "allow" ? "text-emerald-500" : "text-amber-500"}`}>
          {rule.enforcement_action?.replace(/_/g, " ")}
        </span>
        <span className="ml-auto text-[10px] text-gray-400">
          Score: {(rule.score * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

// ── Example card ────────────────────────────────────────────────────────────
const DECISION_COLORS = {
  block: "text-red-600 dark:text-red-400",
  allow: "text-emerald-600 dark:text-emerald-400",
};

function ExampleCard({ example }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
      <div className="flex items-start justify-between gap-2">
        <p className="italic text-gray-700 dark:text-gray-200 line-clamp-2">"{example.user_request}"</p>
        <Pill color={RISK_COLORS[example.risk_level]}>{example.risk_level}</Pill>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-gray-500">
        <span>Role: <strong>{example.user_role}</strong></span>
        <span>·</span>
        <span className={`font-bold ${DECISION_COLORS[example.expected_decision] ?? ""}`}>
          {example.expected_decision}
        </span>
        <span>·</span>
        <span>{example.expected_domain}</span>
      </div>
    </div>
  );
}

// ── Next-action banner ──────────────────────────────────────────────────────
const NEXT_ACTION_META = {
  capability_request_or_schema_generation: {
    icon: "mdi:tools",
    color: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300",
    label: "Capability Request Required",
    desc: "These tools need an MCP schema before they can execute. Submit a capability request or generate the ERPBridge schema.",
  },
  escalate: {
    icon: "mdi:account-alert-outline",
    color: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300",
    label: "Escalation Required",
    desc: "A required governance rule is missing. Escalate to the governance owner.",
  },
  execute: {
    icon: "mdi:check-circle-outline",
    color: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300",
    label: "Ready to Execute",
    desc: "A workflow candidate passed all validation checks.",
  },
};

function NextActionBanner({ nextAction }) {
  const meta = NEXT_ACTION_META[nextAction] ?? {
    icon: "mdi:information-outline",
    color: "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
    label: nextAction?.replace(/_/g, " ") ?? "Unknown",
    desc: "",
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${meta.color}`}>
      <Icon icon={meta.icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-bold">{meta.label}</p>
        {meta.desc && <p className="mt-0.5 opacity-80">{meta.desc}</p>}
      </div>
    </div>
  );
}

// ── MAIN COMPONENT ──────────────────────────────────────────────────────────
// ── Simple inline bar chart ─────────────────────────────────────────────────
function MiniBarChart({ vis }) {
  if (!vis || !Array.isArray(vis.data) || vis.data.length === 0) return null;
  const max = Math.max(...vis.data.map((d) => d.value), 1);
  return (
    <div className="mt-2 rounded-xl border border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-darkBackground">
      <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{vis.title}</p>
      <div className="space-y-1.5">
        {vis.data.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-right text-gray-500 dark:text-gray-400">{d.label}</span>
            <div className="flex-1 rounded-full bg-gray-100 dark:bg-gray-800" style={{ height: 8 }}>
              <div
                className="rounded-full bg-primary"
                style={{ width: `${(d.value / max) * 100}%`, height: 8 }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-semibold text-gray-700 dark:text-gray-300">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Query / Audit result panel ──────────────────────────────────────────────
function QueryResultPanel({ artifact }) {
  const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
  const { visualisation, boundHit, iterationsUsed, latencyMs, intent } = artifact;

  return (
    <div className="space-y-3">
      {/* ── Intent badge ── */}
      <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 dark:border-blue-900/40 dark:bg-blue-900/20">
        <Icon icon={intent === "AUDIT" ? "mdi:magnify-scan" : "mdi:database-search-outline"} className="h-4 w-4 text-blue-500" />
        <span className="text-xs font-bold text-blue-700 dark:text-blue-300">{intent === "AUDIT" ? "Audit Query" : "Data Query"}</span>
        {typeof iterationsUsed === "number" && (
          <span className="ml-auto text-[10px] text-blue-500">{iterationsUsed} tool call{iterationsUsed !== 1 ? "s" : ""}</span>
        )}
        {typeof latencyMs === "number" && (
          <span className="text-[10px] text-blue-400">{(latencyMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      {/* ── Bound hit warning ── */}
      {boundHit && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
          <Icon icon="mdi:alert-outline" className="h-4 w-4 shrink-0" />
          Search ended early — iteration or token limit reached.
        </div>
      )}

      {/* ── Visualisation ── */}
      {visualisation && <MiniBarChart vis={visualisation} />}

      {/* ── Sources ── */}
      {sources.length > 0 && (
        <Collapsible title="Sources" icon="mdi:api" count={sources.length}>
          <div className="space-y-1.5">
            {sources.map((call, i) => (
              <div key={i} className="rounded-lg border border-gray-100 bg-gray-50 p-2 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
                <p className="font-mono font-semibold text-gray-800 dark:text-white">{call.name}</p>
                {Object.keys(call.arguments ?? {}).length > 0 && (
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all text-[10px] text-gray-400 dark:text-gray-500">
                    {JSON.stringify(call.arguments, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </Collapsible>
      )}
    </div>
  );
}

function ChatArtifactPanel({ artifact }) {
  const { startWorkflow } = useRoute();
  const { has } = usePermissions();
	const canEditWorkflow = has("workflow:write");

  if (!artifact) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-darkBackground">
        <Icon icon="tabler:git-branch" className="h-10 w-10 text-gray-300 dark:text-gray-600" />
        <p className="text-sm font-semibold text-gray-400 dark:text-gray-500">No artifact yet</p>
        <p className="max-w-[200px] text-xs text-gray-400 dark:text-gray-600">
          Send a request to generate and validate a workflow.
        </p>
      </div>
    );
  }

  // Query / Audit path (intent-routed)
  if (artifact.intent === "QUERY" || artifact.intent === "AUDIT") {
    return <QueryResultPanel artifact={artifact} />;
  }

  const {
    blocking_errors: rawBlockingErrors,
    can_execute,
    candidates: rawCandidates,
    next_action,
    retrieval = {},
    validation_summary = {},
    selected_workflow_yaml,
    selected_candidate_id,
    chatSessionId,
    chatMessageId,
    traceId,
  } = artifact;

  const blocking_errors = rawBlockingErrors ?? [];
  const candidates = rawCandidates ?? [];

  const tools = retrieval.tools ?? [];
  const rules = [...(retrieval.rules ?? []), ...(retrieval.global_rules ?? [])];
  const examples = retrieval.examples ?? [];

  const handlePassToCanvas = () => {
    if (!can_execute || !selected_workflow_yaml) return;

    saveWorkflowForCanvas({
      yaml: selected_workflow_yaml,
      candidateId: selected_candidate_id,
      canExecute: can_execute,
      validationSummary: validation_summary,
      source: "chat_semantic_validator",
      chatSessionId,
      chatMessageId,
      traceId,
    });
    startWorkflow();
  };

  return (
    <div className="space-y-3">
      {/* ── Validation summary ── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
        <SectionHeader icon="mdi:shield-check-outline" label="Validation" />
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Passed", value: validation_summary.passed_candidates ?? 0, color: "text-emerald-600 dark:text-emerald-400" },
            { label: "Blocked", value: validation_summary.blocked_candidates ?? 0, color: "text-red-500 dark:text-red-400" },
            { label: "Best Score", value: validation_summary.best_score != null ? (validation_summary.best_score * 100).toFixed(0) + "%" : "—", color: "text-primary" },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-xl bg-gray-50 p-2 text-center dark:bg-darkBackgroundVery">
              <p className={`text-lg font-black ${color}`}>{value}</p>
              <p className="text-[10px] text-gray-400">{label}</p>
            </div>
          ))}
        </div>

        {/* can_execute badge */}
        <div className="mt-3 flex items-center gap-2">
          <Icon
            icon={can_execute ? "mdi:check-circle" : "mdi:block-helper"}
            className={`h-4 w-4 ${can_execute ? "text-emerald-500" : "text-red-500"}`}
          />
          <span className={`text-xs font-semibold ${can_execute ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {can_execute ? "Executable candidate available" : "No executable candidate"}
          </span>
        </div>
        {canEditWorkflow && can_execute && selected_workflow_yaml && (
          <button
            type="button"
            onClick={handlePassToCanvas}
            className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-slate-950 px-3 text-xs font-bold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
          >
            <Icon icon="mdi:graph-outline" className="h-4 w-4" />
            Pass to Canvas
          </button>
        )}
      </div>

      {/* ── Next action ── */}
      {next_action && <NextActionBanner nextAction={next_action} />}

      {/* ── Blocking errors ── */}
      {blocking_errors.length > 0 && (
        <Collapsible
          title="Blocking Errors"
          icon="mdi:alert-circle-outline"
          count={blocking_errors.length}
          defaultOpen
        >
          <div className="space-y-2">
            {blocking_errors.map((err, i) => (
              <div key={i} className="flex gap-2 rounded-lg bg-red-50 p-2 text-xs dark:bg-red-900/20">
                <Icon icon="mdi:close-circle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                <p className="text-red-700 dark:text-red-300">{err}</p>
              </div>
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Retrieved Tools ── */}
      {tools.length > 0 && (
        <Collapsible title="Retrieved Tools" icon="mdi:tools" count={tools.length} defaultOpen>
          <div className="space-y-2">
            {tools.map((tool) => (
              <ToolCard key={tool.tool_id} tool={tool} />
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Governance Rules ── */}
      {rules.length > 0 && (
        <Collapsible title="Governance Rules" icon="mdi:scale-balance" count={rules.length}>
          <div className="space-y-2">
            {rules.map((rule) => (
              <RuleCard key={rule.rule_id} rule={rule} />
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Similar Examples ── */}
      {examples.length > 0 && (
        <Collapsible title="Similar Scenarios" icon="mdi:lightbulb-outline" count={examples.length}>
          <div className="space-y-2">
            {examples.map((ex) => (
              <ExampleCard key={ex.scenario_id} example={ex} />
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── Candidates (if any) ── */}
      {candidates.length > 0 && (
        <Collapsible title="Candidates" icon="mdi:format-list-bulleted-square" count={candidates.length}>
          <div className="space-y-2 text-xs">
            {candidates.map((c, i) => (
              <div key={c.id ?? i} className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 dark:border-gray-800 dark:bg-darkBackgroundVery">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-gray-800 dark:text-white">{c.id ?? `Candidate ${i + 1}`}</span>
                  <Pill color={c.status === "PASS" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"}>
                    {c.status ?? "—"}
                  </Pill>
                </div>
                {c.score != null && <p className="mt-1 text-gray-400">Score: {(c.score * 100).toFixed(1)}%</p>}
              </div>
            ))}
          </div>
        </Collapsible>
      )}

      {/* ── YAML preview ── */}
      {selected_workflow_yaml && (
        <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
          <SectionHeader icon="mdi:code-braces" label="Generated YAML" />
          <pre className="max-h-64 overflow-auto rounded-xl bg-gray-900 p-3 text-[10px] leading-5 text-green-300">
            {selected_workflow_yaml}
          </pre>
        </div>
      )}
    </div>
  );
}

export default ChatArtifactPanel;
