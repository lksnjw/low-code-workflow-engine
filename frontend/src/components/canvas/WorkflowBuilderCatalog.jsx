import { Handle, Position } from "@xyflow/react";
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  Database,
  FileCheck2,
  GripVertical,
  Loader2,
  Mail,
  PackageCheck,
  Search,
  ShieldCheck,
  ShoppingCart,
  UserCheck,
  UserSearch,
  Warehouse,
} from "lucide-react";
import { apiErrorMessage } from "../../services/api";

const iconMap = {
  AlertCircle,
  Boxes,
  Database,
  FileCheck2,
  Mail,
  PackageCheck,
  Search,
  ShieldCheck,
  ShoppingCart,
  UserCheck,
  UserSearch,
  Warehouse,
};

const statusMeta = {
  idle: {
    label: "Idle",
    border: "border-slate-200",
    glow: "shadow-[0_18px_38px_rgba(15,23,42,0.08)]",
    badge: "bg-slate-100 text-slate-600",
    icon: null,
  },
  running: {
    label: "Running",
    border: "border-blue-500 ring-4 ring-blue-500/15",
    glow: "shadow-[0_0_32px_rgba(37,99,235,0.35)]",
    badge: "bg-blue-50 text-blue-700",
    icon: Loader2,
  },
  success: {
    label: "Success",
    border: "border-emerald-500",
    glow: "shadow-[0_0_28px_rgba(16,185,129,0.22)]",
    badge: "bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  error: {
    label: "Error",
    border: "border-red-500",
    glow: "shadow-[0_0_28px_rgba(220,38,38,0.22)]",
    badge: "bg-red-50 text-red-700",
    icon: AlertCircle,
  },
};

const toneClasses = {
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  green: "bg-green-50 text-green-700 border-green-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
};

export function WorkflowToolNode({ data, selected }) {
  const Icon = iconMap[data.iconKey] ?? Database;
  const meta = statusMeta[data.status ?? "idle"] ?? statusMeta.idle;
  const StatusIcon = meta.icon;

  return (
    <div
      className={`min-w-[236px] rounded-lg border bg-white px-4 py-3 text-slate-950 transition-all duration-200 ${meta.border} ${meta.glow} ${
        selected ? "outline outline-2 outline-offset-2 outline-slate-900/20" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-white !bg-slate-400"
      />
      <div className="flex items-start gap-3">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${
            toneClasses[data.tone] ?? toneClasses.blue
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-950">{data.label}</p>
              <p className="mt-1 truncate text-xs font-semibold text-slate-500">{data.action}</p>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-bold ${meta.badge}`}
            >
              {StatusIcon ? (
                <StatusIcon
                  className={`h-3.5 w-3.5 ${data.status === "running" ? "animate-spin" : ""}`}
                />
              ) : null}
              {meta.label}
            </span>
          </div>
          <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{data.description}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">
        <span>{data.role}</span>
        <span>{data.status === "running" ? "Executing" : data.nodeTypeLabel || "ERP Tool"}</span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-white !bg-slate-700"
      />
    </div>
  );
}

function ToolCatalogItem({ tool }) {
  const Icon = iconMap[tool.iconKey] ?? Database;
  const handleDragStart = (event) => {
    event.dataTransfer.setData("application/agentic-tool", JSON.stringify(tool));
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <button
      type="button"
      draggable={Boolean(tool.inputSchema)}
      disabled={!tool.inputSchema}
      onDragStart={handleDragStart}
      className="group flex w-full items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md"
    >
      <span
        className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
          toneClasses[tool.tone] ?? toneClasses.blue
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-slate-900">{tool.label}</span>
        <span className="mt-1 block text-xs leading-5 text-slate-500">{tool.description}</span>
        {!tool.inputSchema && <span className="mt-1 block text-xs text-amber-700">Reviewed input schema unavailable. Refresh the connection before adding this tool.</span>}
      </span>
      <GripVertical className="mt-2 h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-500" />
    </button>
  );
}

export function BuilderSidebar({ groups = [], loading, error }) {
  return (
    <aside className="flex h-screen w-[300px] shrink-0 flex-col border-r border-slate-200 bg-slate-50">
      <div className="border-b border-slate-200 px-5 py-5">
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">Tool Catalog</p>
        <h2 className="mt-2 text-xl font-black text-slate-950">ERP Components</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Drag tools into the canvas and connect them into governed execution flows.
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {loading ? <p className="text-sm text-slate-500">Loading registered tools…</p> : null}
        {error ? <p className="text-sm text-red-600">{apiErrorMessage(error, "Tool catalog unavailable.")}</p> : null}
        {!loading && !error && groups.length === 0 ? <p className="text-sm text-slate-500">No available tools are registered.</p> : null}
        {groups.map((group) => (
          <section key={group.title}>
            <div className="mb-3">
              <h3 className="text-sm font-extrabold text-slate-900">{group.title}</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">{group.description}</p>
            </div>
            <div className="grid gap-3">
              {group.tools.map((tool) => (
                <ToolCatalogItem key={`${group.title}-${tool.label}`} tool={tool} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}
