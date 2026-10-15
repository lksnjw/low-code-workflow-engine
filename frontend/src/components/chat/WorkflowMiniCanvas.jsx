import { Fragment, useId, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import ReadFlowTree from "./ReadFlowTree";
import ReadableValue from "./ReadableValue";
import { miniWorkflowGraph, miniNodeEvidence, unselectedMiniNodes } from "./miniWorkflowGraph";
import { createPortal } from "react-dom";
import { useChatWorkspace } from "./ChatWorkspaceContext";
import WorkflowRequirementSummary from "./WorkflowRequirementSummary";

const icons = { input: "lucide:file-input", if: "lucide:git-branch", foreach: "lucide:repeat-2", protect: "lucide:shield-check", return: "lucide:flag", approval: "lucide:hand" };
const types = { input: "Run preparation", if: "Decision", foreach: "Repeat", protect: "Error handler", return: "Finish", approval: "Human approval" };

export default function WorkflowMiniCanvas(props) {
  // Reset display state only; the saved editor, proposal and input forms stay mounted.
  return <WorkflowMiniCanvasView key={props.viewReset} {...props} />;
}

function WorkflowMiniCanvasView({ simple, run, declaredStructure, ...props }) {
  const workspace = useChatWorkspace();
  const docked = Boolean(simple && workspace);
  const inTools = (content, key) => docked ? workspace.canvasToolsHost ? createPortal(content, workspace.canvasToolsHost, key) : null : content;
  const [view, setView] = useState("canvas"), [zoom, setZoom] = useState(1), [query, setQuery] = useState("");
  const [approvalSelection, setApprovalSelection] = useState(null);
  const { selectedId } = props;
  const selectedApproval = approvalSelection && approvalSelection.context === selectedId ? approvalSelection.id : null;
  const setSelectedApproval = id => setApprovalSelection({ id, context: selectedId });
  const scroller = useRef(null), marker = useId().replaceAll(":", "");
  const recordedApprovalNode = props.timeline?.findLast(item => item.status === "AWAITING_APPROVAL")?.nodeId;
  const waitingNode = (props.approvalWaiting ?? (!run || run.status === "AWAITING_APPROVAL")) ? props.pendingApprovalNode || recordedApprovalNode : undefined;
  const approvalNodes = [...new Set([...(props.approvalNodes || []), ...(recordedApprovalNode ? [recordedApprovalNode] : []), ...(waitingNode ? [waitingNode] : [])])];
  const graph = (() => {
    const base = miniWorkflowGraph(props.steps, props.flow, declaredStructure, approvalNodes);
    if (!props.onPrepareInputs || base.error || !base.nodes.length) return base;
    const first = base.nodes[0], offset = base.nodeWidth + 64;
    // A display-only input entry, never an ERP step or a saved workflow mutation.
    return { ...base, width: base.width + offset, nodes: [{ id: "$run-inputs", kind: "input", title: "Inputs & documents", x: first.x, y: first.y }, ...base.nodes.map(node => ({ ...node, x: node.x + offset }))], edges: [{ from: "$run-inputs", to: first.id, label: "Reviewed inputs" }, ...base.edges] };
  })();
  const unselected = unselectedMiniNodes(props.flow, props.decisions);
  const renderActionWithApproval = (step, index) => <Fragment key={step.id}>
    {approvalNodes.includes(step.id) && <li aria-label={`Human approval before ${step.id}`} className="relative z-10 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/30">
      <p className="font-semibold">Human approval · {step.source.description || step.id}</p>
      <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-300">{step.id === waitingNode ? "Run paused before this action." : "A separate exact transaction review is required before this action can dispatch."}</p>
      {step.id === waitingNode && <button type="button" onClick={() => props.onReviewApproval?.()} className="mt-1 font-semibold text-primary">Review exact transaction here</button>}
    </li>}
    {props.renderAction(step, index)}
  </Fragment>;
  const tree = () => <ReadFlowTree {...props} renderAction={renderActionWithApproval} />;
  if (!simple) return tree();
  const selected = graph.nodes.find(node => node.id === selectedApproval) || graph.nodes.find(node => node.id === props.selectedId);
  const selectedIndex = graph.nodes.indexOf(selected);
  const go = node => {
    if (!node) return;
    if (node.kind === "input") { setSelectedApproval(node.id); props.onPrepareInputs?.(); }
    else if (node.kind === "approval") { setSelectedApproval(node.id); if (node.control.nodeId === waitingNode) props.onReviewApproval?.(); }
    else { setSelectedApproval(null); props.onSelectCondition(node.id); }
    scroller.current?.scrollTo?.({ left: Math.max(0, node.x * zoom - 32), top: Math.max(0, node.y * zoom - 48), behavior: "smooth" });
  };
  const matches = query.trim() ? graph.nodes.filter(node => `${node.title} ${node.id}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8) : [];
  return <section aria-label="Connected workflow preview" className={docked ? "flex min-h-0 flex-1 flex-col" : undefined}>
    {inTools(<div className="mb-3 flex items-center gap-1 border-b border-gray-200 dark:border-gray-700" role="tablist" aria-label="Workflow view">
      {[ ["canvas", "Mini canvas"], ["tree", "Workflow preview"] ].map(([id, title]) => <button key={id} type="button" role="tab" aria-selected={view === id} aria-controls={`workflow-${marker}-${id}`} onClick={() => setView(id)} className={`border-b-2 px-3 py-2 text-xs font-semibold ${view === id ? "border-primary text-primary" : "border-transparent text-gray-500"}`}>{title}</button>)}
      <span className="ml-auto text-[10px] text-gray-500">{props.steps.length} {props.steps.length === 1 ? "step" : "steps"}</span>
    </div>, "canvas-view")}
    {!graph.error && graph.nodes.length === 0 ? <div role="status" aria-label={props.savedDraft ? "Empty saved workflow" : "Empty workflow"} className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-md space-y-3 border-l-2 border-amber-400 pl-4 text-sm">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">This {props.savedDraft ? "saved " : ""}draft has no steps yet</h3>
        <p className="text-xs leading-5 text-gray-500">{props.savedDraft ? "Your draft is saved, but it needs executable steps before it can run." : "There are no workflow nodes to draw yet. This preview does not confirm that the draft is saved or runnable."}</p>
        <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Complete the missing details first. This is not a pending approval, so there is no OK or Approve action yet.</p>
        <WorkflowRequirementSummary issues={props.unresolvedRequirements} />
        <div className="flex flex-wrap gap-2">
          {props.onContinueChat && <button type="button" disabled={props.busy} onClick={props.onContinueChat} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50">Complete in chat</button>}
          {props.onOpenControls && <button type="button" disabled={props.busy} onClick={props.onOpenControls} className="rounded-md border border-primary/30 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/5 disabled:opacity-50 dark:border-fuchsia-400/40 dark:text-fuchsia-300">Review requirements and add steps</button>}
        </div>
        {props.emptyDescription && <details className="text-xs text-gray-600 dark:text-gray-300"><summary className="cursor-pointer font-medium">Draft description</summary><p className="mt-2 leading-5">{props.emptyDescription}</p></details>}
        {Array.isArray(props.unresolvedRequirements) && props.unresolvedRequirements.length > 0 && <details><summary className="cursor-pointer text-xs font-medium text-primary dark:text-fuchsia-300">Technical requirements · {props.unresolvedRequirements.length}</summary><ul className="mt-2 list-disc space-y-2 pl-4 text-xs text-gray-500">{props.unresolvedRequirements.map((issue, index) => <li key={index}>{typeof issue === "string" ? issue : "Review this unresolved requirement in the saved workflow source."}</li>)}</ul></details>}
      </div>
    </div> : view === "tree" ? <div role="tabpanel" id={`workflow-${marker}-tree`} className={docked ? "min-h-0 flex-1 overflow-auto p-5" : undefined}>{tree()}</div> : <div role="tabpanel" id={`workflow-${marker}-canvas`} className={docked ? "flex min-h-0 flex-1 flex-col" : undefined}>
      {graph.error ? <><p role="alert" className="mb-3 text-xs text-amber-700">{graph.error}</p>{tree()}</> : <>
        {inTools(<div className="mb-4 flex flex-wrap items-center gap-1.5">
          <div className="relative min-w-32 flex-1"><input aria-label="Find workflow step" placeholder="Find a step…" value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs dark:border-gray-700 dark:bg-gray-900" />
            {query.trim() && <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-auto rounded-md border bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">{matches.length ? matches.map(node => <button type="button" key={node.id} className="block w-full rounded px-2 py-2 text-left text-xs hover:bg-primary/10" onClick={() => { go(node); setQuery(""); }}>{node.title}</button>) : <p className="p-2 text-xs text-gray-500">No matching steps</p>}</div>}
          </div>
          <button type="button" aria-label="Previous workflow node" disabled={selectedIndex <= 0} onClick={() => go(graph.nodes[selectedIndex - 1])} className="mini-canvas-control"><Icon icon="lucide:chevron-left" /></button>
          <button type="button" aria-label="Next workflow node" disabled={selectedIndex === graph.nodes.length - 1} onClick={() => go(graph.nodes[selectedIndex + 1])} className="mini-canvas-control"><Icon icon="lucide:chevron-right" /></button>
          <button type="button" aria-label="Zoom out canvas" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))} className="mini-canvas-control">−</button>
          <button type="button" aria-label="Reset canvas zoom" onClick={() => setZoom(1)} className="mini-canvas-control text-[10px]">{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in canvas" disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, value + .25))} className="mini-canvas-control">+</button>
          <button type="button" aria-label="Fit canvas to panel" onClick={() => { setZoom(Math.max(.5, Math.min(1, (scroller.current?.clientWidth || graph.width) / graph.width))); scroller.current?.scrollTo?.({ left: 0, top: 0 }); }} className="mini-canvas-control px-2 text-[10px]">Fit</button>
        </div>, "canvas-zoom")}
        <div ref={scroller} aria-label="Workflow node connections" tabIndex={0} style={docked ? undefined : { height: Math.min(340, Math.max(220, graph.height * zoom)) }} className={`mini-workflow-surface overflow-auto border-gray-200 dark:border-gray-700 ${docked ? "min-h-0 flex-1" : "rounded-lg border"}`}>
          <div style={{ width: graph.width * zoom, height: graph.height * zoom }}><div className="relative origin-top-left" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0" width={graph.width} height={graph.height}>
              <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
              {graph.edges.map((edge, index) => {
                const from = graph.nodes.find(node => node.id === edge.from), to = graph.nodes.find(node => node.id === edge.to);
                const receipt = edge.branch && props.decisions?.[edge.branch.nodeId];
                const chosen = receipt?.status === "DONE" && receipt.selected === edge.branch.path;
                const unchosen = receipt?.status === "DONE" && ["then", "else"].includes(edge.branch.path) && !chosen;
                const down = to.y !== from.y, backwards = to.x <= from.x;
                const x1 = from.x + (backwards && down ? graph.nodeWidth / 2 : graph.nodeWidth), y1 = from.y + (backwards && down ? graph.nodeHeight : graph.nodeHeight / 2);
                const x2 = to.x + (backwards && down ? graph.nodeWidth / 2 : 0), y2 = to.y + (backwards && down ? 0 : graph.nodeHeight / 2);
                const middle = (x1 + x2) / 2;
                const labelY = down ? (y1 + y2) / 2 - 8 : y1 - 8;
                const path = backwards && down ? `M${x1},${y1} V${(y1 + y2) / 2} H${x2} V${y2}` : backwards ? `M${x1},${y1} C${x1 + 70},${y1 + 100} ${x2 - 70},${y2 + 100} ${x2},${y2}` : `M${x1},${y1} H${middle} V${y2} H${x2}`;
                return <g key={index} opacity={unchosen ? .3 : 1}><path d={path} fill="none" stroke={chosen ? "#059669" : "#94a3b8"} strokeWidth={chosen ? 2.5 : 1.5} strokeDasharray={edge.branch?.path === "repeat" || unchosen ? "5 4" : undefined} markerEnd={`url(#${marker})`} />{edge.label && <text x={middle + 4} y={labelY} className="fill-gray-600 dark:fill-gray-300" fontSize="10" fontWeight="600">{edge.label}{chosen ? " ✓" : ""}</text>}</g>;
              })}
            </svg>
            {graph.nodes.map(node => {
              const evidenceId = node.kind === "approval" ? node.control.nodeId : node.id;
              let evidence = unselected.has(evidenceId) ? { label: "Not selected", tone: "idle" } : miniNodeEvidence(evidenceId, run, props.iterations ? [] : props.timeline, props.decisions, props.values);
              if (node.kind === "approval") evidence = evidenceId === waitingNode ? { label: "Paused · Review here", tone: "attention" } : evidence.tone === "done" ? { label: "Passed in this run", tone: "done" } : evidence.label === "Not selected" || evidence.label === "Skipped" || evidence.label === "Review recorded · Check run" ? evidence : { label: "Required before this action", tone: "idle" };
              if (node.kind === "input") evidence = { label: "Upload image/PDF or enter fields", tone: "idle" };
              const active = node.id === selected?.id;
              const kind = types[node.kind] || (node.step?.source.kind === "approval" ? "Human approval" : node.step?.source.kind === "analysis" ? "Analysis" : node.step?.source.kind === "agent" ? "Assistant" : "ERP step");
              return <button type="button" key={node.id} aria-label={`Select ${node.kind === "action" ? "step" : node.kind === "if" ? "decision" : node.kind} ${node.title}`} aria-pressed={active} onClick={() => go(node)} className={`mini-workflow-node mini-node-${evidence.tone} ${active ? "mini-node-selected" : ""}`} style={{ left: node.x, top: node.y, width: graph.nodeWidth, height: graph.nodeHeight }}>
                <span className="flex items-center gap-2 text-[10px] text-gray-500"><Icon icon={icons[node.kind] || (kind === "Analysis" ? "lucide:brain-circuit" : "lucide:database")} className="h-4 w-4 text-primary" />{kind}{node.index !== undefined && <span className="ml-auto">{node.index + 1}</span>}</span>
                <span className="mt-2 line-clamp-2 block text-xs font-semibold leading-4">{node.title}</span>
                <span className="mini-node-status mt-auto block text-[10px]">{evidence.label}</span>
              </button>;
            })}
          </div></div>
        </div>
        {selected?.kind === "approval" && <aside aria-label="Human approval checkpoint details" className="shrink-0 border-t border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <p><strong>Human approval</strong> · {selected.control.nodeId === waitingNode ? "This run is paused before this action. Review its exact arguments to approve or reject." : "This is a runtime checkpoint, not a workflow-edit approval. A review is requested when the run reaches this action."}</p>
          {selected.control.nodeId === waitingNode && <button type="button" onClick={() => props.onReviewApproval?.()} className="font-semibold underline">Review exact transaction here</button>}
        </aside>}
        {inTools(<div>
        <p className="mt-2 text-[10px] text-gray-500">Follow the arrows. Select a step to see its answer and edit it.</p>
        {selected?.step ? <ol aria-label="Selected step and answer" className="mt-4 list-none">{props.renderAction(selected.step, selected.index)}</ol> : !selected && <p className="mt-4 text-xs text-gray-500">Select any node to begin.</p>}
        {selected && !selected.step && props.values?.[selected.id]?.status === "DONE" && Object.hasOwn(props.valueOutputs?.[selected.id] || {}, "value") && <section aria-label="Selected node result" className="mt-4 border-l-2 border-primary pl-3"><h4 className="mb-2 text-xs font-semibold">{selected.title} · Saved result</h4><ReadableValue value={props.valueOutputs[selected.id].value} /></section>}
        </div>, "canvas-answer")}
      </>}
    </div>}
  </section>;
}
