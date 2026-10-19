import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { serializeSourceOrderCanvas, sameWorkflowSource, sourceOrderCanvasValidationPayload } from "../../utils/builderSerialization";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  peekWorkflowForCanvas,
  clearWorkflowForCanvas,
  workflowCreationPayload,
  workflowYamlToCanvas,
  saveWorkflowForChatEdit,
} from "../../utils/workflowCanvas.utils";
import { catalogService } from "../../services/catalog.service";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { apiErrorDetails, apiErrorMessage } from "../../services/api";
import { useNotifications } from "../../context/NotificationContext";
import GateRejectionAlert from "../workflows/GateRejectionAlert";
import WorkflowRunDialog from "../workflows/WorkflowRunDialog";
import { BuilderSidebar, WorkflowToolNode } from "./WorkflowBuilderCatalog";
import {
  BuilderHeader,
  BuilderLoadState,
  CanvasValidationBanner,
  ExecutionResultPanel,
  StructuredCanvasNotice,
} from "./WorkflowBuilderPanels";

/*******************************************************************************
 * Function: getInitialCanvasState
 *
 * Gets initial canvas state for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function getInitialCanvasState() {
  const pendingWorkflow = peekWorkflowForCanvas();
  if (pendingWorkflow?.yaml) {
    try {
    const canvas = workflowYamlToCanvas(pendingWorkflow.yaml, {
      candidateId: pendingWorkflow.candidateId,
      chatSessionId: pendingWorkflow.chatSessionId,
      chatMessageId: pendingWorkflow.chatMessageId,
      traceId: pendingWorkflow.traceId,
      workflowId: pendingWorkflow.workflowId,
    });
    return { ...canvas, payload: pendingWorkflow };
    } catch (error) {
      return { nodes: [], edges: [], payload: pendingWorkflow, sourceError: error.message, workflow: { id: pendingWorkflow.workflowId ?? null, name: pendingWorkflow.name || "Unsupported imported draft", description: "Source preserved; no graph semantics inferred.", yaml: pendingWorkflow.yaml } };
    }
  }

  return {
    nodes: [],
    edges: [],
    workflow: {
      id: null,
      name: "Untitled workflow",
      description: "Workflow created in the governed visual builder.",
      yaml: "",
    },
  };
}

/*******************************************************************************
 * Function: WorkflowBuilderSurface
 *
 * Performs the Workflow Builder Surface operation on builder surface for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function WorkflowBuilderSurface({ readOnly = false, initialState = null, embedded = false }) {
  const navigate = useNavigate();
  const reactFlowWrapper = useRef(null);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [initialCanvasState] = useState(() => initialState ?? getInitialCanvasState());
  useEffect(() => { if (initialCanvasState.payload && !initialCanvasState.sourceError) clearWorkflowForCanvas(initialCanvasState.payload); }, [initialCanvasState]);
  const nodeIdRef = useRef(initialCanvasState.nodes.length + 1);
  const [nodes, setNodes] = useState(initialCanvasState.nodes);
  const [edges, setEdges] = useState(initialCanvasState.edges);
  const [workflow, setWorkflow] = useState(initialCanvasState.workflow);
  const [executionState, setExecutionState] = useState("idle");
  const [isExecuting, setIsExecuting] = useState(false);
  const [runError, setRunError] = useState(null);
  const [executionResult, setExecutionResult] = useState(null);
  const [showResultPanel, setShowResultPanel] = useState(false);
  const [canvasValidation, setCanvasValidation] = useState(null);
  const [isValidating, setIsValidating] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [runReview, setRunReview] = useState(null);
  const structuredCanvas = workflow.canvasProfile === "structured-control-flow/v1";
  const effectiveSelectedNodeId = selectedNodeId && nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : null;
  const { notify } = useNotifications();
/*******************************************************************************
 * Function: catalogQuery
 *
 * Performs the catalog Query operation on query for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const catalogQuery = useQuery({
    queryKey: ["tool-catalog-groups"],
    queryFn: () => catalogService.toolGroups(),
    enabled: !readOnly && !embedded && !structuredCanvas,
  });
/*******************************************************************************
 * Function: nodeTypes
 *
 * Performs the node Types operation on types for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const nodeTypes = useMemo(() => ({ erpTool: WorkflowToolNode }), []);

/*******************************************************************************
 * Function: statusCounts
 *
 * Performs the status Counts operation on counts for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const statusCounts = useMemo(
    () =>
      nodes.reduce(
        (accumulator, node) => {
          const status = node.data.status ?? "idle";
          accumulator[status] = (accumulator[status] ?? 0) + 1;
          return accumulator;
        },
        { idle: 0, running: 0, success: 0, error: 0 },
      ),
    [nodes],
  );

/*******************************************************************************
 * Function: onNodesChange
 *
 * Performs the on Nodes Change operation on nodes change for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const onNodesChange = useCallback((changes) => {
    setCanvasValidation(null);
    setNodes((currentNodes) => applyNodeChanges(structuredCanvas ? changes.filter((change) => ["select", "dimensions"].includes(change.type)) : changes, currentNodes));
  }, [structuredCanvas]);

/*******************************************************************************
 * Function: onEdgesChange
 *
 * Performs the on Edges Change operation on edges change for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const onEdgesChange = useCallback((changes) => {
    setCanvasValidation(null);
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
  }, []);

/*******************************************************************************
 * Function: onConnect
 *
 * Performs the on Connect operation on connect for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const onConnect = useCallback((connection) => {
    setCanvasValidation(null);
    setEdges((currentEdges) =>
      addEdge(
        {
          ...connection,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "#475569", strokeWidth: 2 },
        },
        currentEdges,
      ),
    );
  }, []);

/*******************************************************************************
 * Function: handleDragOver
 *
 * Handles drag over for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

/*******************************************************************************
 * Function: handleDrop
 *
 * Handles drop for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setCanvasValidation(null);

      const rawTool = event.dataTransfer.getData("application/agentic-tool");
      if (!rawTool) return;

      const tool = JSON.parse(rawTool);
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const nextId = `node-${nodeIdRef.current}`;
      nodeIdRef.current += 1;

      setNodes((currentNodes) => [
        ...currentNodes,
        {
          id: nextId,
          type: "erpTool",
          position,
          data: {
            ...tool,
            status: "idle",
          },
        },
      ]);
    },
    [screenToFlowPosition],
  );

/*******************************************************************************
 * Function: workflowYAML
 *
 * Performs the workflow YAML operation on yaml for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const workflowYAML = useCallback(() => structuredCanvas ? workflow.yaml : serializeSourceOrderCanvas(workflow, nodes, edges), [edges, nodes, structuredCanvas, workflow]);

/*******************************************************************************
 * Function: deployWorkflow
 *
 * Performs the deploy Workflow operation on workflow for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const deployWorkflow = useCallback(async () => {
    if (nodes.length === 0) throw new Error("Add at least one registered tool before deploying.");
    const yaml = workflowYAML();
    let saved = workflow;
    let reviewed;
    if (workflow.id) {
      const revision = await workflowService.readiness(workflow.id);
      if (!workflow.yaml || !sameWorkflowSource(revision.yaml, workflow.yaml)) throw new Error("Saved draft changed. Reload it in the chat workspace before publishing.");
      reviewed = await workflowService.command(workflow.id, revision, { type: "restoreDraft", yaml });
    } else {
      saved = await workflowService.create(
        workflowCreationPayload(workflow, yaml),
      );
      reviewed = await workflowService.readiness(saved.id);
      if (!sameWorkflowSource(reviewed.yaml, yaml)) throw new Error("Created draft changed. Reload before publishing.");
    }
    // Retain the saved draft even if publication fails; a second attempt must
    // not create another workflow or forget the acknowledged draft revision.
    saved = { ...saved, id: saved.id, yaml };
    setWorkflow(saved);
    await workflowService.publish(saved.id, "Published from visual builder", reviewed);
    fitView({ padding: 0.2, duration: 400 });
    notify(`Workflow ${saved.name} published. It has not been executed.`, "success");
    return saved;
  }, [fitView, nodes.length, notify, workflow, workflowYAML]);

/*******************************************************************************
 * Function: executeWorkflow
 *
 * Executes workflow for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const executeWorkflow = useCallback(async (input) => {
    if (isExecuting || nodes.length === 0) return;
    setIsExecuting(true);
    setExecutionState("running");
    setRunError(null);
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        data: { ...node.data, status: "idle" },
      })),
    );

    try {
      if (!workflow.id) throw new Error("Save and explicitly publish this draft before requesting execution. Run does not publish.");
      const readiness = await workflowService.readiness(workflow.id);
      if (!sameWorkflowSource(workflowYAML(), readiness.yaml)) throw new Error("Canvas has unsaved changes. Review and publish them explicitly before running.");
      // A click opens the same input/OCR/source review as saved workflows.
      // React passes an event to button handlers; only the review form supplies
      // business input. No empty-object admission is sent by opening Run.
      if (!input || typeof input.preventDefault === "function") { setRunReview(readiness); setExecutionState("idle"); return; }
      if (!readiness.can_attempt_run) throw new Error("The saved workflow is not ready: check publication, validation, supported semantics and ERP connection in the chat workspace.");
      const mode = readiness.operation_job_admission === "operation-job/v1" ? "async-operation" : readiness.read_job_admission === "read-job-v1" ? "async-read" : null;
      if (!mode) throw new Error("Queued execution is unavailable. Check the saved workflow's execution profile.");
      const execution = await workflowService.run(workflow.id, input, { mode, idempotencyKey: crypto.randomUUID() });
      if (!execution?.id) throw new Error("The run receipt was not confirmed. Check Execution History before another run.");
      setRunReview(null);
      if (!["DONE", "FAILED", "CANCELLED"].includes(execution.status)) {
        setExecutionState("idle"); navigate(`/executions/${encodeURIComponent(execution.id)}`); return execution;
      }
      const timeline = await executionService.getTimeline(execution.id);
/*******************************************************************************
 * Function: statusByNode
 *
 * Performs the status By Node operation on by node for the WorkflowBuilderCanvas module.
 ******************************************************************************/
      const statusByNode = new Map(timeline.map((step) => [step.nodeId, step.status]));
      setNodes((currentNodes) =>
        currentNodes.map((node) => ({
          ...node,
          data: { ...node.data, status: statusByNode.get(node.id) === "DONE" ? "success" : statusByNode.get(node.id) === "FAILED" ? "error" : "idle" },
        })),
      );
      const succeeded = execution.status === "DONE";
      setExecutionState(succeeded ? "success" : "error");
      setExecutionResult({ execution, timeline });
      setShowResultPanel(true);
      notify(`Execution ${execution.id} finished with status ${execution.status}.`, succeeded ? "success" : "warning");
      return execution;
    } catch (error) {
      setExecutionState("error");
      const details = error?.response ? apiErrorDetails(error, "Workflow execution failed.") : { message: error.message || "Workflow execution failed.", meta: null };
      setRunError(details);
      notify(details.message, "error");
      const executionId = error?.response?.data?.meta?.executionId;
      if (executionId) {
        try {
          const [execution, timeline] = await Promise.all([executionService.get(executionId), executionService.getTimeline(executionId)]);
          const statuses = new Map(timeline.map((step) => [step.nodeId, step.status]));
          setNodes((items) => items.map((node) => ({ ...node, data: { ...node.data, status: statuses.get(node.id) === "DONE" ? "success" : statuses.get(node.id) === "FAILED" ? "error" : "idle" } })));
          setExecutionResult({ execution, timeline }); setShowResultPanel(true);
        } catch { notify("The failed run was recorded, but its details could not be loaded.", "warning"); }
      }
    } finally {
      setIsExecuting(false);
    }
  }, [isExecuting, nodes.length, notify, workflow, workflowYAML, navigate]);

/*******************************************************************************
 * Function: handleDeploy
 *
 * Handles deploy for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const handleDeploy = useCallback(async () => {
    setIsExecuting(true);
    try { await deployWorkflow(); }
    catch (error) { notify(error?.response ? apiErrorMessage(error, "Workflow publication failed.") : error.message || "Workflow publication failed.", "error"); }
    finally { setIsExecuting(false); }
  }, [deployWorkflow, notify]);

  const validateCanvas = useCallback(async () => {
    setIsValidating(true); setCanvasValidation(null);
    try {
      const payload = structuredCanvas ? { yaml: workflow.yaml } : sourceOrderCanvasValidationPayload(workflow, nodes, edges);
      const result = await workflowService.validateCanvas(payload);
      setCanvasValidation({ passed: result.validation?.passed === true, findings: result.step_errors || [], message: result.validation?.errors?.[0] });
    } catch (error) {
      const details = error?.response ? apiErrorDetails(error, "Canvas validation failed.") : { message: error.message || "Canvas validation failed.", meta: null };
      const issues = Array.isArray(details.meta?.issues) ? details.meta.issues.map((message) => ({ node_id: null, message })) : [];
      setCanvasValidation({ passed: false, findings: issues, message: details.message });
    } finally { setIsValidating(false); }
  }, [edges, nodes, structuredCanvas, workflow]);

  const handleEditInChat = useCallback(() => {
    let yaml = workflow.yaml || "";
    if (!yaml && nodes.length > 0) {
      try { yaml = workflowYAML(); } catch { /* cycle or empty */ }
    }
    saveWorkflowForChatEdit(workflow.id
      ? { workflowId: workflow.id, workflowName: workflow.name, ...(effectiveSelectedNodeId ? { selectedNodeId: effectiveSelectedNodeId } : {}) }
      : { yaml, workflowId: null, workflowName: workflow.name });
    navigate("/chat?new=1");
  }, [workflow, nodes, workflowYAML, navigate, effectiveSelectedNodeId]);

  return (
    <div className={`${embedded ? "relative h-full" : "fixed inset-y-0 right-0 left-0 z-50 md:left-16"} flex overflow-hidden bg-slate-100 text-slate-950`}>
      {!readOnly && !embedded && !structuredCanvas ? <BuilderSidebar groups={catalogQuery.data || []} loading={catalogQuery.isLoading} error={catalogQuery.error} /> : null}
      <section className="flex min-w-0 flex-1 flex-col">
        <BuilderHeader
          executionState={executionState}
          isExecuting={isExecuting}
          isValidating={isValidating}
          onValidate={validateCanvas}
          onRun={executeWorkflow}
          onDeploy={handleDeploy}
          readOnly={readOnly}
          statusCounts={statusCounts}
          workflow={workflow}
          editNodeId={effectiveSelectedNodeId}
          onEditInChat={!readOnly && (nodes.length > 0 || workflow.yaml) ? handleEditInChat : undefined}
        />
        <CanvasValidationBanner result={canvasValidation} onClose={() => setCanvasValidation(null)} />
        {structuredCanvas ? <StructuredCanvasNotice onEditInChat={readOnly ? undefined : handleEditInChat} /> : null}
        {runError ? <div className="shrink-0 bg-white px-6 py-2"><GateRejectionAlert details={runError} /></div> : null}
        {initialCanvasState.sourceError && <div role="alert" className="shrink-0 border-b border-amber-200 bg-amber-50 px-6 py-3 text-xs text-amber-800"><p>Import cannot be represented: {initialCanvasState.sourceError}. Its source is preserved; nothing was saved or published.</p><details className="mt-2"><summary>Original source</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{workflow.yaml}</pre></details><button className="mt-2 underline" onClick={handleEditInChat}>Review source in chat</button></div>}
        <div className="min-h-0 flex-1 bg-slate-100 p-4">
          <div
            ref={reactFlowWrapper}
            className="h-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_20px_50px_rgba(15,23,42,0.10)]"
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={readOnly ? undefined : onNodesChange}
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              onEdgesChange={readOnly || structuredCanvas ? undefined : onEdgesChange}
              onConnect={readOnly || structuredCanvas ? undefined : onConnect}
              onDrop={readOnly || structuredCanvas ? undefined : handleDrop}
              onDragOver={readOnly || structuredCanvas ? undefined : handleDragOver}
              nodesDraggable={!readOnly && !structuredCanvas}
              nodesConnectable={!readOnly && !structuredCanvas}
              elementsSelectable={!readOnly}
              fitView
              defaultEdgeOptions={{
                type: "smoothstep",
                markerEnd: { type: MarkerType.ArrowClosed },
              }}
              connectionLineStyle={{ stroke: "#2563eb", strokeWidth: 2 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#cbd5e1" gap={24} size={1.4} />
              <Controls position="bottom-right" />
              <MiniMap
                position="bottom-left"
                nodeColor={(node) => {
                  if (node.data.status === "running") return "#2563eb";
                  if (node.data.status === "success") return "#10b981";
                  if (node.data.status === "error") return "#dc2626";
                  return "#94a3b8";
                }}
                maskColor="rgba(15, 23, 42, 0.08)"
              />
            </ReactFlow>
          </div>
        </div>
      </section>
      {showResultPanel && executionResult ? (
        <ExecutionResultPanel
          result={executionResult}
          onClose={() => setShowResultPanel(false)}
        />
      ) : null}
      <WorkflowRunDialog open={Boolean(runReview)} workflowId={workflow.id} initialRecord={runReview} onClose={() => setRunReview(null)} onRun={input => executeWorkflow(input)} disabled={isExecuting} />
    </div>
  );
}

/*******************************************************************************
 * Function: WorkflowBuilderCanvas
 *
 * Performs the Workflow Builder Canvas operation on builder canvas for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function WorkflowBuilderCanvas({ readOnly = false, workflowId = null, embedded = false }) {
/*******************************************************************************
 * Function: workflowQuery
 *
 * Performs the workflow Query operation on query for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const workflowQuery = useQuery({
    queryKey: ["builder-workflow", workflowId],
    queryFn: async () => {
      const [record, yamlRecord] = await Promise.all([
        workflowService.getById(workflowId),
        workflowService.getYAML(workflowId),
      ]);
      const canvas = workflowYamlToCanvas(yamlRecord.yaml, {
        name: record.name,
        description: record.description,
      });
      return {
        ...canvas,
        workflow: {
          ...canvas.workflow,
          id: record.id,
          name: record.name,
          description: record.description,
        },
      };
    },
    enabled: Boolean(workflowId),
  });

  if (workflowId && workflowQuery.isLoading) return <BuilderLoadState embedded={embedded} />;
  if (workflowQuery.error) return <BuilderLoadState embedded={embedded} error={workflowQuery.error} />;

  return (
    <ReactFlowProvider>
      <WorkflowBuilderSurface
        key={workflowId ?? "draft"}
        readOnly={readOnly}
        initialState={workflowQuery.data ?? null}
        embedded={embedded}
      />
    </ReactFlowProvider>
  );
}

export default WorkflowBuilderCanvas;
