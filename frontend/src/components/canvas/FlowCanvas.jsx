import { Icon } from "@iconify/react";
import { STATUS_META } from "../../constants/workflowStatus";

/*******************************************************************************
 * Function: FlowCanvas
 *
 * Performs the Flow Canvas operation on canvas for the FlowCanvas module.
 ******************************************************************************/
function FlowCanvas({ nodes = [], edges = [] }) {
  return <div className="workflow-canvas-grid relative h-[560px] overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800"><svg className="absolute inset-0 h-full w-full" aria-hidden="true">{edges.map((edge) => { const source = nodes.find((node) => node.id === edge.source); const target = nodes.find((node) => node.id === edge.target); if (!source || !target) return null; const x1 = (source.position?.x || 0) + 168; const y1 = (source.position?.y || 0) + 42; const x2 = target.position?.x || 0; const y2 = (target.position?.y || 0) + 42; return <path key={edge.id || `${edge.source}-${edge.target}`} d={`M ${x1} ${y1} C ${x1 + 55} ${y1}, ${x2 - 55} ${y2}, ${x2} ${y2}`} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/40" />; })}</svg>{nodes.map((node) => { const meta = STATUS_META[node.status] || STATUS_META.PENDING; return <div key={node.id} className="workflow-node absolute p-4" style={{ left: node.position?.x || 0, top: node.position?.y || 0 }}><div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary"><Icon icon={node.icon || "tabler:git-branch"} className="h-5 w-5" /></span><div className="min-w-0"><p className="text-sm font-bold text-gray-950 dark:text-white">{node.label}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{node.type}</p></div></div><span className={`mt-4 inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${meta.color}`}>{meta.label}</span></div>; })}</div>;
}

export default FlowCanvas;
