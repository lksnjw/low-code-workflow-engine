import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon } from "@iconify/react";
import { takeWorkflowForCanvas, workflowYamlToCanvas, saveWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";
import { workflowService } from "../../services/workflow.service";

// ── Read-only step node ────────────────────────────────────────────────────────
function ViewNode({ data }) {
  const [open, setOpen] = useState(false);
  const hasOutput = data.executionOutput !== undefined && data.executionOutput !== null;
  const hasParams = data.parameters && Object.keys(data.parameters).length > 0;

  const statusIcon = data.executionStatus === "success"
    ? "mdi:check-circle"
    : data.executionStatus === "blocked"
      ? "mdi:shield-alert"
      : data.executionStatus === "error"
        ? "mdi:alert-circle"
        : "mdi:circle-outline";
  const statusColor = data.executionStatus === "success"
    ? "text-emerald-500"
    : data.executionStatus === "blocked"
      ? "text-amber-500"
      : data.executionStatus === "error"
        ? "text-red-500"
        : "text-gray-400";

  return (
    <div className="min-w-[220px] max-w-[280px] rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Icon icon="mdi:cog-outline" className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-gray-900 dark:text-white">{data.label}</p>
          <p className="truncate text-[10px] text-gray-400">{data.action}</p>
        </div>
        <Icon icon={statusIcon} className={`h-4 w-4 shrink-0 ${statusColor}`} />
      </div>

      {(hasParams || hasOutput) && (
        <div className="border-t border-gray-100 px-3.5 pb-3 dark:border-gray-800">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 flex w-full items-center gap-1 text-[10px] font-semibold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <Icon icon={open ? "mdi:chevron-up" : "mdi:chevron-down"} className="h-3 w-3" />
            {open ? "Hide" : "Show"} details
          </button>
          {open && (
            <div className="mt-2 space-y-1.5">
              {hasParams && (
                <div>
                  <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-widest text-gray-400">Parameters</p>
                  {Object.entries(data.parameters).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-1 text-[10px]">
                      <span className="font-mono text-gray-500">{k}:</span>
                      <span className="truncate text-gray-700 dark:text-gray-300">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
              {hasOutput && (
                <div>
                  <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-widest text-gray-400">Last Output</p>
                  <pre className="max-h-24 overflow-auto rounded bg-gray-50 p-1.5 text-[9px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {typeof data.executionOutput === "string"
                      ? data.executionOutput
                      : JSON.stringify(data.executionOutput, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const NODE_TYPES = { erpTool: ViewNode, default: ViewNode };

// ── Main component ─────────────────────────────────────────────────────────────
function WorkflowViewCanvas() {
  const navigate = useNavigate();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [workflow, setWorkflow] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [rerunStatus, setRerunStatus] = useState(null);

  useEffect(() => {
    const payload = takeWorkflowForCanvas();
    if (!payload) return;

    const { yaml, name, description, steps: toolSteps } = payload;
    if (!yaml) return;

    const canvas = workflowYamlToCanvas(yaml, { name, description });
    const stepsMap = {};
    if (Array.isArray(toolSteps)) {
      for (const s of toolSteps) stepsMap[s.toolName] = s;
    }

    const enrichedNodes = canvas.nodes.map((node) => {
      const stepData = stepsMap[node.data.action];
      return {
        ...node,
        type: "erpTool",
        draggable: false,
        selectable: false,
        data: {
          ...node.data,
          executionOutput: stepData?.result ?? null,
          executionStatus: stepData !== undefined ? (stepData.error ? "error" : "success") : undefined,
        },
      };
    });

    setNodes(enrichedNodes);
    setEdges(canvas.edges);
    setWorkflow({ ...canvas.workflow, yaml });
  }, []);

  const handleSave = useCallback(async () => {
    if (!workflow || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await workflowService.create({
        name: workflow.name || "Chat Workflow",
        description: workflow.description || "Saved from chat agent",
        yaml: workflow.yaml,
      });
      setSaved(true);
    } catch (error) {
      setSaveError(error?.response?.data?.message ?? error.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }, [workflow, saving]);

  const handleDelete = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setWorkflow(null);
    setSaved(false);
    setSaveError(null);
  }, []);

  const handleRerun = useCallback(async () => {
    if (!workflow) return;
    setRerunStatus("running");
    try {
      // Navigate to canvas builder with this YAML pre-loaded for execution
      const { saveWorkflowForCanvas } = await import("../../utils/workflowCanvas.utils.js");
      saveWorkflowForCanvas({ yaml: workflow.yaml, name: workflow.name, description: workflow.description });
      navigate("/builder");
    } catch {
      setRerunStatus("error");
    }
  }, [workflow, navigate]);

  if (!workflow && nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 dark:bg-gray-800">
          <Icon icon="mdi:vector-square" className="h-8 w-8 text-gray-400" />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">No workflow loaded</p>
          <p className="mt-1 text-xs text-gray-400">Use "View in Canvas" from a chat response to load a workflow here.</p>
        </div>
        <button
          type="button"
          onClick={() => navigate("/chat")}
          className="mt-2 flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
        >
          <Icon icon="hugeicons:ai-magic" className="h-4 w-4" />
          Go to Chat
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-0">
      {/* ── Canvas area ── */}
      <div className="relative flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="var(--color-canvas-dots, #e2e8f0)" />
          <Controls showInteractive={false} />
          <MiniMap zoomable pannable className="!rounded-xl !border !border-gray-200 dark:!border-gray-700" />
        </ReactFlow>

        {/* Read-only badge */}
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-gray-200 bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-gray-500 backdrop-blur-sm dark:border-gray-700 dark:bg-gray-900/90 dark:text-gray-400">
          <Icon icon="mdi:eye-outline" className="h-3 w-3" />
          Read-only view
        </div>
      </div>

      {/* ── Side panel ── */}
      <div className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
        {/* Workflow info */}
        <div>
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Workflow</p>
          <h2 className="text-sm font-bold text-gray-900 dark:text-white">{workflow?.name || "Agent Workflow"}</h2>
          {workflow?.description && (
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{workflow.description}</p>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              {nodes.length} step{nodes.length !== 1 ? "s" : ""}
            </span>
            {nodes.some((n) => n.data.executionOutput !== null) && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
                Has execution results
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || saved}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:opacity-60"
          >
            <Icon icon={saved ? "mdi:check" : saving ? "mdi:loading" : "mdi:content-save"} className={`h-4 w-4 ${saving ? "animate-spin" : ""}`} />
            {saved ? "Saved to workflows" : saving ? "Saving…" : "Save to Workflows"}
          </button>

          <button
            type="button"
            onClick={handleRerun}
            disabled={rerunStatus === "running"}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Icon icon="mdi:play-outline" className="h-4 w-4" />
            Open in Builder
          </button>

          <button
            type="button"
            onClick={() => {
              saveWorkflowForChatEdit({ yaml: workflow?.yaml || "", workflowId: null, workflowName: workflow?.name || "Workflow" });
              navigate("/chat?new=1");
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Icon icon="mdi:chat-outline" className="h-4 w-4" />
            Edit in Chat
          </button>

          <button
            type="button"
            onClick={handleDelete}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 py-2.5 text-sm font-semibold text-red-600 transition hover:bg-red-50 dark:border-red-800/40 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <Icon icon="mdi:delete-outline" className="h-4 w-4" />
            Discard
          </button>
        </div>

        {saveError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400">
            <Icon icon="mdi:alert-circle" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {saveError}
          </div>
        )}

        {/* Step summary */}
        {nodes.length > 0 && (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Steps</p>
            <div className="space-y-1.5">
              {nodes.map((node, i) => (
                <div key={node.id} className="flex items-center gap-2 rounded-lg border border-gray-100 px-2.5 py-2 dark:border-gray-800">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate text-xs text-gray-700 dark:text-gray-300">{node.data.label}</span>
                  {node.data.executionStatus && (
                    <Icon
                      icon={node.data.executionStatus === "success" ? "mdi:check-circle" : node.data.executionStatus === "error" ? "mdi:alert-circle" : "mdi:shield-alert"}
                      className={`h-3.5 w-3.5 shrink-0 ${node.data.executionStatus === "success" ? "text-emerald-500" : node.data.executionStatus === "error" ? "text-red-500" : "text-amber-500"}`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* YAML preview */}
        {workflow?.yaml && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">YAML</p>
            <pre className="max-h-48 overflow-auto rounded-xl bg-gray-900 p-3 text-[9px] leading-4 text-green-300">
              {workflow.yaml}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default WorkflowViewCanvas;
