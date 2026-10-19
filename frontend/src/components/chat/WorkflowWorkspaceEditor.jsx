import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { createPortal } from "react-dom";
import { useChatWorkspace } from "./ChatWorkspaceContext";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { useRunAdmissionRecovery } from "../../hooks/useRunAdmissionRecovery";
import RunAdmissionRecoveryPanel from "../executions/RunAdmissionRecoveryPanel";
import { parseWorkflowPreview } from "./workflowPreview";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";
import "./workflowWorkspace.css";
import ReadableValue, { ReadableResult } from "./ReadableValue";
import ValueFields from "./ValueFields";
import SchemaFields from "./SchemaFields";
import WorkflowMiniCanvas from "./WorkflowMiniCanvas";
import WorkflowSourcePreview from "./WorkflowSourcePreview";
import { useExecutionMonitor } from "../../hooks/useExecutionMonitor";
import ExecutionRunControls from "../executions/ExecutionRunControls";
import OperationReconciliationEvidence from "../executions/OperationReconciliationEvidence";
import OperationStatusQueries from "../executions/OperationStatusQueries";
import { isActiveExecution } from "../../utils/executionEvents";
import NodePrompt from "./NodePrompt";
import ModelInputFields from "./ModelInputFields";
import ConditionFields, { ScopeSelect, branchDestination, flowConditions, flowReturns } from "./ConditionFields";
import ReadValueFields, { SchemaContractFields, ReadBindingFields } from "./ReadValueFields";
import ReadSimulationPanel from "./ReadSimulationPanel";
import { flowLoops } from "./CollectionFields";
import CollectionInspector, { CollectionWrapForm } from "./CollectionInspector";
import CollectionPatchPreview from "./CollectionPatchPreview";
import ConditionPatchPreview from "./ConditionPatchPreview";
import ProtectedPatchPreview from "./ProtectedPatchPreview";
import WorkflowEditHistory from "./WorkflowEditHistory";
import { flowPlacementModel, movePlacementPreview, insertionPlacementPreview, insertionPositionValue } from "./flowPlacement";
import { FlowMoveHandle, FlowPlacementPoint, CanvasInsertionForm, ModelInsertionPosition } from "./FlowPlacementControls";
import IterationNodeEvidence from "../executions/IterationNodeEvidence";
import { projectIterationEvidence } from "../../utils/iterationEvidence";
import AnalysisNodeInspector from "./AnalysisNodeInspector";
import AgentNodeInspector from "./AgentNodeInspector";
import PublishedWorkflowRunForm from "./PublishedWorkflowRunForm";
import WorkflowRunApproval from "./WorkflowRunApproval";
import ProtectedGroupInspector, { ProtectedWrapForm } from "./ProtectedGroupInspector";
import { flowProtectedGroups, isOperationProfile, protectedChatUnavailable, protectedGroupPatchVersion } from "./protectedFlow";
import WorkflowRunDialog from "../workflows/WorkflowRunDialog";
import WorkflowDialog from "../workflows/WorkflowDialog";
import WorkflowFixButton from "./WorkflowFixButton";
import WorkflowResults from "../workflows/WorkflowResults";

const button = "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-800";
const input = "w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground";
const message = (error) => error?.response?.data?.message || error?.message || "The operation could not be completed.";
const emptyTimeline = [];
const stepStatus = (attempt, hasOutput, runStatus) => {
  if (hasOutput && attempt?.status !== "FAILED") return { label: "Answer ready", tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" };
  if (attempt?.status === "FAILED") return { label: "Stopped", tone: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300" };
  if (attempt?.status === "UNKNOWN") return { label: "Check outcome", tone: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" };
  if (attempt?.status === "AWAITING_APPROVAL") return { label: runStatus === "AWAITING_APPROVAL" ? "Needs approval" : "Review recorded", tone: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" };
  if (attempt?.status === "RUNNING") return { label: "Working", tone: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" };
  if (attempt?.status === "SKIPPED") return { label: "Skipped", tone: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" };
  if (attempt?.status === "DONE") return { label: "Completed", tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" };
  return null;
};

function NodeAnswer({ output, attempt, runId, analysis, agent, selected }) {
  const scope = `${runId ?? ""}:${Boolean(selected)}`;
  const [toggle, setToggle] = useState(null);
  const open = toggle?.scope === scope ? toggle.open : Boolean(selected);
  const label = attempt?.status === "FAILED" ? "Node failure response" : analysis ? "Structured analysis answer" : agent ? "Agent structured answer" : "Node answer";
  return <details open={open} className="workspace-node-answer relative z-10 ml-10 mt-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[10px] shadow-sm dark:border-gray-700 dark:bg-gray-900">
    <summary onClick={event => { event.preventDefault(); setToggle({ scope, open: !open }); }} className="cursor-pointer font-medium text-gray-700 dark:text-gray-200">{label} · run {runId}</summary>
    {open && <div className="workspace-reveal mt-2 max-h-64 overflow-auto border-t border-gray-100 pt-2 dark:border-gray-800"><ReadableResult value={output} /></div>}
  </details>;
}

function WorkflowProgress({ record, shownRun, workflowId }) {
  const stages = [
    { label: "Review", detail: record.validation?.passed ? "Draft checked" : "Fix issues", done: record.validation?.passed },
    { label: "Publish", detail: record.published ? "Version published" : "Your approval", done: record.published },
    { label: "Run", detail: shownRun ? String(shownRun.status || "Recorded").replaceAll("_", " ").toLowerCase() : "Start when ready", done: shownRun?.status === "DONE" },
  ];
  return <nav aria-label="Workflow progress" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
    {stages.map((stage, index) => <div key={stage.label} className={`rounded-lg border px-2.5 py-2 ${stage.done ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20" : "border-gray-200 bg-white dark:border-gray-700 dark:bg-darkBackground"}`}>
      <p className="flex items-center gap-1.5 text-[10px] font-semibold"><span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${stage.done ? "bg-emerald-600 text-white" : "bg-gray-100 text-gray-500 dark:bg-gray-800"}`}>{stage.done ? <Icon icon="lucide:check" /> : index + 1}</span>{stage.label}</p>
      <p className="mt-1 truncate text-[9px] text-gray-500">{stage.detail}</p>
    </div>)}
    <a href={`/workflows/${encodeURIComponent(workflowId)}#schedule`} className="rounded-lg border border-gray-200 bg-white px-2.5 py-2 transition hover:border-primary hover:text-primary dark:border-gray-700 dark:bg-darkBackground">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold"><span className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-100 text-[9px] text-gray-500 dark:bg-gray-800">4</span>Schedule</p>
      <p className="mt-1 truncate text-[9px] text-gray-500">Run automatically</p>
    </a>
  </nav>;
}
function ConditionInspector({ node, canEdit, busy, onPreview, onMergePreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring, operationFlow = false, mergesSupported = false }) {
  const [predicate, setPredicate] = useState(node.predicate);
  const [merge, setMerge] = useState(node.merge || null);
  return <aside aria-label="Selected condition details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <h4 className="mb-4 text-sm font-semibold">Condition · {node.id}</h4>
    {canEdit ? <><form className="space-y-3" onSubmit={event => { event.preventDefault(); onPreview({ predicate }); }}>
      <ConditionFields value={predicate} onChange={setPredicate} dataSources={authoring?.dataSources} /><button disabled={busy} className={`${button} border border-gray-200 dark:border-gray-700`}>Preview condition edit</button>
    </form>{sharedChat ? <p className="mt-4 text-xs text-gray-500">This condition is selected in the main chat. Request a condition or typed branch-output change, then review and apply the proposal. Node ID and branch contents stay unchanged; server validation decides whether the draft is supported.</p> : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} placeholder="Change this condition or its Yes / No output…" scopeHelp="Only this condition's predicate and typed branch output are in scope. Branch contents and ID stay unchanged. Review before Apply; nothing runs automatically." />}</> : <ReadableValue value={node.predicate} />}
    <p className="mt-3 text-[10px] text-gray-500">If yes: {node.then.nodes.length} direct items · If no: {node.else.nodes.length} direct items. Move actions explicitly to change their scope.</p>
    {operationFlow && <p className="mt-3 text-[10px] text-gray-500">Typed returns stop later nodes. Calendar joins require complete reports on every continuing path; a summary alone is not report evidence. Selected invoice keys may pass through a typed branch output to a later related-order read. That read requires the selected complete invoice receipt, not invented or model-generated keys. Include each requested report or analysis in the message; keys alone are not report content. If No means no delivery, end that path before any shared send. Publication, scheduling and independent effect approval remain separate.</p>}
    {canEdit && (!operationFlow || mergesSupported) ? <form className="mt-4 space-y-4 border-t pt-4" onSubmit={event => { event.preventDefault(); onMergePreview(merge); }}><h5 className="text-xs font-semibold">Branch output</h5>
      <label className="text-xs text-gray-500"><input type="checkbox" aria-label="Declare branch output" checked={Boolean(merge)} onChange={event => setMerge(event.target.checked ? node.merge || { schema: { type: "string" }, then: { kind: "literal", value: "" }, else: { kind: "literal", value: "" } } : null)} /> Declare one typed output for both paths</label>
      {merge && <><SchemaContractFields schema={merge.schema} onChange={schema => setMerge({ ...merge, schema })} label="Branch output contract" />{["then", "else"].map(branch => <ReadBindingFields key={branch} value={merge[branch]} onChange={value => setMerge({ ...merge, [branch]: value })} dataSources={authoring?.mergeSources?.[branch]} label={`${branch === "then" ? "If yes" : "If no"} output`} />)}</>}
      <p className="text-[10px] text-gray-500">Only the selected path's value is exposed as {node.id} → value. Missing data fails; no default is substituted. A return inside a path bypasses this merge.</p>
      <button disabled={busy} className={button}>Preview branch output edit</button>
    </form> : operationFlow ? <p className="mt-4 text-xs text-gray-500">{mergesSupported ? "Typed branch output is supported by this draft; editing requires workflow edit permission." : "Typed branch output is unavailable without current server guidance; existing mappings are preserved."} Collections are not supported in this execution profile.</p> : node.merge && <ReadableValue value={node.merge} />}
  </aside>;
}
function ReturnInspector({ node, canEdit, busy, onPreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring }) {
  const [output, setOutput] = useState(node.output);
  return <aside aria-label="Selected return details" className="workspace-reveal mt-5 border-t pt-4"><h4 className="mb-4 text-sm font-semibold">Return · {node.id}</h4>
    {canEdit ? <><form className="space-y-3" onSubmit={event => { event.preventDefault(); onPreview(output); }}><ReadValueFields value={output} onChange={setOutput} dataSources={authoring?.dataSources} /><button disabled={busy} className={button}>Preview return edit</button></form>
      {sharedChat ? <p className="mt-4 text-xs text-gray-500">This return is selected in the main chat. Requests may change its output only; location and other nodes stay unchanged.</p> : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} />}</> : <ReadableValue value={node.output} />}
    <p className="mt-3 text-[10px] text-gray-500">A confirmed return stops all later actions on the selected path. Skipped actions have no tool answer. Scheduled returns do not activate a schedule, approve an effect or prove delivery.</p>
  </aside>;
}
function NodeInspector({ node, canEdit, busy, onPreview, sessionId, context, onProposal, sharedChat, draftStorageKey, authoring, connections = [] }) {
  const [description, setDescription] = useState(node.source.description ?? "");
  const [action, setAction] = useState(node.source.action ?? "");
  const [parameters, setParameters] = useState(node.source.parameters ?? {});
  const [connectionId, setConnectionId] = useState(node.source.connection_id ?? authoring?.connectionId ?? connections.find(item => item.primary)?.id ?? "erpbridge-default");
  const [error, setError] = useState("");
  const tool = !node.source.kind || node.source.kind === "tool";
  const guide = authoring?.actions?.includes(action) ? authoring : null;
  return <aside aria-label="Selected node details" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="mb-4 flex items-center gap-2"><Icon icon="lucide:sliders-horizontal" className="h-4 w-4 text-gray-400" /><h4 className="text-sm font-semibold">{node.id}</h4><span className="ml-auto text-[10px] text-gray-400">{node.source.kind || "tool"}</span></div>
    {canEdit ? <>
      <form onSubmit={(event) => { event.preventDefault(); try { onPreview({ description, ...(tool ? { action, ...(node.source.connection_id || connections.length ? { connection_id: connectionId } : {}), parameters } : {}) }); setError(""); } catch (cause) { setError(message(cause)); } }} className="space-y-3">
        <label className="block text-xs text-gray-500">Label<input aria-label="Node label" className={`${input} mt-1`} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} /></label>
        {tool && <>{connections.length > 0 && <label className="block text-xs text-gray-500">ERPBridge connection<select aria-label="Node ERPBridge connection" className={`${input} mt-1`} value={connectionId} onChange={event => setConnectionId(event.target.value)}>{connections.map(item => <option key={item.id} value={item.id}>{item.id}{item.primary ? " · primary" : ""}</option>)}</select></label>}<label className="block text-xs text-gray-500">Registered tool<input aria-label="Node tool" className={`${input} mt-1 font-mono`} value={action} onChange={(event) => setAction(event.target.value)} required maxLength={128} /></label>
          <div className="space-y-2"><p className="text-xs text-gray-500">Parameters</p>{guide?.inputSchema ? <><p className="text-[10px] text-gray-500">Registered schema · required fields and scoped data. This is guidance, not live readiness.</p><SchemaFields schema={guide.inputSchema} value={parameters} onChange={setParameters} dataSources={guide.dataSources} /></> : <><p className="text-[10px] text-gray-500">No current supported schema guidance for this tool. Values are preserved; validation decides whether it can run.</p><ValueFields value={parameters} onChange={setParameters} /></>}</div></>}
        <button disabled={busy} className={`${button} border border-gray-200 dark:border-gray-700`}><Icon icon="lucide:git-compare-arrows" />Preview manual edit</button>
      </form>
      {sharedChat ? <p className="mt-5 border-t border-gray-100 pt-4 text-xs leading-5 text-gray-500 dark:border-gray-800">This node is selected for editing in the main chat. Describe your change there; review the returned proposal before applying it.</p> : <NodePrompt sessionId={sessionId} context={context} busy={busy} onProposal={onProposal} draftStorageKey={draftStorageKey} />}
    </> : <ReadableValue value={node.source} />}
    {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
  </aside>;
}

export default function WorkflowWorkspaceEditor({ workflowId, sessionId, actorId, canEdit = false, canControl = false, simple = false, viewReset, initialSelectedNodeId = "", selectionStorageKey, onChatChanged, savedProposals = [], onNodeContext, onWorkflowContext, onFocusChat }) {
  const workspace = useChatWorkspace();
  const docked = Boolean(simple && workspace);
  const inspectorRef = useRef(null);
  const approvalRef = useRef(null);
  const inTools = (content, key) => docked ? workspace.canvasToolsHost ? createPortal(content, workspace.canvasToolsHost, key) : null : content;
  const [record, setRecord] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => {
    const stored = readWorkspaceValue(selectionStorageKey ? `${selectionStorageKey}.node` : null, null);
    return stored === null ? initialSelectedNodeId : stored;
  });
  const [proposal, setProposal] = useState(null), [showHistory, setShowHistory] = useState(false);
  const [resolvedProposals, setResolvedProposals] = useState([]), [notice, setNotice] = useState("");
  const [run, setRun] = useState(null), [timeline, setTimeline] = useState([]), [runInput, setRunInput] = useState({});
  const [submittingRun, setSubmittingRun] = useState(false);
  const [unconfirmedRun, setUnconfirmedRun] = useState(false);
  const runPending = useRef(false);
  const [showRunDialog, setShowRunDialog] = useState(false), [showSaveDialog, setShowSaveDialog] = useState(false), [showResults, setShowResults] = useState(false);
  const recovery = useRunAdmissionRecovery(workflowId, actorId);
  const exactRun = recovery.denied ? null : recovery.run || (recovery.pending ? null : run);
  const monitor = useExecutionMonitor(exactRun?.id, { enabled: exactRun?.readProgress?.profile === "read-progress-v1" || isActiveExecution(exactRun?.status) });
  const shownRun = monitor.denied ? null : monitor.execution ?? exactRun;
  const shownTimeline = monitor.denied ? emptyTimeline : monitor.execution ? monitor.timeline : exactRun?.id === run?.id ? timeline : emptyTimeline;
  const runActive = isActiveExecution(shownRun?.status);
  const snapshotMatches = shownRun?.workflowSnapshot?.yaml === record?.yaml;
  const [adding, setAdding] = useState(false), [newId, setNewId] = useState(""), [newAction, setNewAction] = useState(""), [newConnectionId, setNewConnectionId] = useState("");
  const [addingAnalysis, setAddingAnalysis] = useState(false), [newAnalysisId, setNewAnalysisId] = useState(""), [newAnalysisBefore, setNewAnalysisBefore] = useState("");
  const [newAnalysisInstruction, setNewAnalysisInstruction] = useState(""), [newAnalysisInput, setNewAnalysisInput] = useState("");
  const [newAnalysisClass, setNewAnalysisClass] = useState("internal"), [newAnalysisModel, setNewAnalysisModel] = useState("");
  const [newAnalysisSchema, setNewAnalysisSchema] = useState({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false });
  const [addingAgent, setAddingAgent] = useState(false), [newAgentId, setNewAgentId] = useState(""), [newAgentBefore, setNewAgentBefore] = useState("");
  const [newAgentInstruction, setNewAgentInstruction] = useState(""), [newAgentInput, setNewAgentInput] = useState(""), [newAgentAction, setNewAgentAction] = useState("");
  const [newAgentConnectionId, setNewAgentConnectionId] = useState("");
  const [newAgentClass, setNewAgentClass] = useState("internal"), [newAgentModel, setNewAgentModel] = useState("");
  const [newAgentSchema, setNewAgentSchema] = useState({ type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false });
  const [addScope, setAddScope] = useState("root"), [moveScope, setMoveScope] = useState("root");
  const [conditionMode, setConditionMode] = useState(null), [conditionId, setConditionId] = useState("");
  const [conditionPredicate, setConditionPredicate] = useState({ kind: "literal", value: false }), [conditionBranch, setConditionBranch] = useState("then"), [conditionScope, setConditionScope] = useState("root");
  const [addingReturn, setAddingReturn] = useState(false), [returnId, setReturnId] = useState(""), [returnScope, setReturnScope] = useState("root");
  const [returnOutput, setReturnOutput] = useState({ schema: { type: "string" }, value: { kind: "literal", value: "" } });
  const [wrappingCollection, setWrappingCollection] = useState(false);
  const [wrappingProtected, setWrappingProtected] = useState(false);
  const [arranging, setArranging] = useState(false), [movingRecord, setMoving] = useState(null), [insertRecord, setInsertTarget] = useState(null);
  const [modelInsertionRevision, setModelInsertionRevision] = useState(null);
  const load = useCallback(async () => { const next = await workflowService.readiness(workflowId); setRecord(next); setNotice(value => value.startsWith("Edit save outcome is unconfirmed.") ? "Authoritative draft reloaded. Review the current revision before another edit." : value); return next; }, [workflowId]);
  useEffect(() => {
    let active = true;
    workflowService.readiness(workflowId).then((value) => { if (active) setRecord(value); }).catch((cause) => { if (active) setError(message(cause)); });
    executionService.list({ workflowId }).then(async (runs) => {
      const latest = runs.filter((item) => item.workflowId === workflowId).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      if (!latest) return;
      const steps = await executionService.getTimeline(latest.id);
      if (active) { setRun(latest); setTimeline(steps); }
    }).catch(() => { /* Historical output is optional; never fabricate it. */ });
    return () => { active = false; };
  }, [workflowId]);
  const preview = useMemo(() => parseWorkflowPreview(record?.yaml), [record?.yaml]);
  const contextVersion = record?.version, contextHash = record?.contentHash;
  const workflowContextPending = !record || Boolean(record.readinessUnknown), workflowContextError = !record && error ? error : null;
  useEffect(() => {
    onWorkflowContext?.({ sessionId, workflowId, workflowName: preview.name || "Workflow", baseVersion: contextVersion,
      baseHash: contextHash, pending: workflowContextPending, unavailableReason: workflowContextError });
    return () => onWorkflowContext?.(null);
  }, [onWorkflowContext, sessionId, workflowId, preview.name, contextVersion, contextHash, workflowContextPending, workflowContextError]);
  const authoring = record?.authoring?.profile === "read-authoring/v1" && !record.readinessUnknown ? record.authoring : null;
  const primaryConnectionId = authoring?.connectionChoices?.find(item => item.primary)?.id ?? authoring?.connectionChoices?.[0]?.id ?? "erpbridge-default";
  const agentConnectionId = newAgentConnectionId || primaryConnectionId;
  const agentReadActions = [...new Set((authoring?.nodes ?? []).filter(item => item.effectClass === "read" && (item.connectionId ?? primaryConnectionId) === agentConnectionId).flatMap(item => item.actions ?? []))];
  const placementModel = useMemo(() => flowPlacementModel(authoring?.controlFlow, preview.steps, preview.metadata?.controlFlow !== undefined), [authoring?.controlFlow, preview.steps, preview.metadata?.controlFlow]);
  const source = record?.yaml, sourceHash = record?.contentHash;
  const iterationModel = useMemo(() => projectIterationEvidence(shownRun, shownTimeline, { yaml: source, sourceHash, flow: authoring?.controlFlow, steps: preview.steps }), [shownRun, shownTimeline, source, sourceHash, authoring?.controlFlow, preview.steps]);
  const node = preview.steps.find((step) => step.id === selected);
  const condition = flowConditions(authoring?.controlFlow).find(item => item.id === selected);
  const returnNode = flowReturns(authoring?.controlFlow).find(item => item.id === selected);
  const collection = flowLoops(authoring?.controlFlow).find(item => item.id === selected);
  const protectedGroup = flowProtectedGroups(authoring?.controlFlow).find(item => item.id === selected);
  const protectedGuidance = authoring?.protectedGroups?.find(item => item.nodeId === protectedGroup?.id);
  const groupChatSupported = protectedGuidance?.patchVersion === protectedGroupPatchVersion;
  const contextPending = !record || Boolean(record.readinessUnknown);
  const nodeId = node?.id || condition?.id || returnNode?.id || collection?.id || protectedGroup?.id || (contextPending ? selected : null), nodeLabel = node?.source.description || (condition ? `Condition ${condition.id}` : returnNode ? `Return ${returnNode.id}` : collection ? `Collection ${collection.id}` : protectedGroup ? `Protected group ${protectedGroup.id}` : nodeId);
  const version = record?.version, contentHash = record?.contentHash;
  const currentPlacement = value => value?.workflowId === workflowId && value.baseVersion === version && value.baseHash === contentHash;
  const moving = currentPlacement(movingRecord) ? movingRecord : null, insertTarget = currentPlacement(insertRecord) ? insertRecord.target : null;
  const supportsModelInsertion = Boolean(authoring?.modelNodesSupported || !preview.metadata?.controlFlow && record?.executionProfile === "sequential-operation-v1");
  const operationFlow = isOperationProfile(record?.executionProfile);
  const supportsReturnInsertion = !operationFlow || authoring?.returnNodesSupported === true;
  const modelInsertionStale = !currentPlacement(modelInsertionRevision);
  useEffect(() => {
    onNodeContext?.(canEdit && nodeId && (contentHash || contextPending) ? { workflowId, sessionId, nodeId, label: nodeLabel, version, contentHash, pending: contextPending,
      unavailableReason: protectedGroup && !groupChatSupported ? protectedChatUnavailable : null,
      onProposal: setProposal, clear: () => { setSelected(""); writeWorkspaceValue(selectionStorageKey ? `${selectionStorageKey}.node` : null, ""); } } : null);
    return () => onNodeContext?.(null);
  }, [onNodeContext, canEdit, workflowId, sessionId, nodeId, nodeLabel, version, contentHash, contextPending, selectionStorageKey, protectedGroup, groupChatSupported]);
  const pendingProposal = (proposal && !resolvedProposals.includes(proposal.id) ? proposal : null) || savedProposals.findLast((item) => item.workflowId === workflowId && item.status === "PROPOSED" && (item.scope === "workflow" || item.baseVersion === record?.version && item.baseHash === record?.contentHash) && !resolvedProposals.includes(item.id));
  const modelInsertionDisabled = busy || record?.readinessUnknown || Boolean(pendingProposal) || !placementModel.valid || modelInsertionStale || !supportsModelInsertion;
  const staleProposal = pendingProposal && (pendingProposal.baseVersion !== version || pendingProposal.baseHash !== contentHash);
  const blockingProposal = Boolean(pendingProposal && !staleProposal);
  const select = id => {
    setSelected(id); writeWorkspaceValue(selectionStorageKey ? `${selectionStorageKey}.node` : null, id); setProposal(null);
    if (docked) {
      workspace.openCanvasTools();
      requestAnimationFrame(() => inspectorRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
    }
  };
  const previewChange = (nodeId, command, before, after) => setProposal({ nodeId, baseVersion: record.version, baseHash: record.contentHash, command, before, after });
  const openModelInsertion = (kind, target) => {
    if (!supportsModelInsertion || !placementModel.valid || busy || record.readinessUnknown || pendingProposal || kind === "agent" && !agentReadActions.length) return;
    setModelInsertionRevision({ workflowId, baseVersion: record.version, baseHash: record.contentHash });
    const position = target ? insertionPositionValue(target) : preview.steps.find(step => authoring?.nodes?.find(item => item.nodeId === step.id)?.effectClass !== "read" && !["analysis", "agent"].includes(step.source.kind))?.id ?? "";
    setAddingAnalysis(kind === "analysis"); setAddingAgent(kind === "agent"); setInsertTarget(null);
    if (kind === "analysis") setNewAnalysisBefore(position);
    else { setNewAgentBefore(position); setNewAgentAction(current => current || agentReadActions[0] || ""); }
  };
  const previewModelInsertion = (type, node, position, after) => {
    if (modelInsertionDisabled) return;
    try {
      const { placement, location } = insertionPlacementPreview(placementModel, position);
      previewChange(node.id, { type, node, ...placement }, { location }, { ...after, location });
    } catch (cause) { setError(message(cause)); }
  };
  const perform = async (action) => { setBusy(true); setError(""); try { await action(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const save = async (command, revision = record) => {
    if (record.readinessUnknown) throw new Error("Reload authoritative workflow storage before another edit.");
    let next;
    try { next = await workflowService.command(workflowId, revision, command); }
    catch (cause) {
      // A proxy/server error may arrive after the draft was committed. Keep
      // the preview, but reload authoritative state before another Apply.
      if (!cause?.response || cause.response.status >= 500 || cause.response.data?.meta?.code === "DRAFT_SAVE_UNCONFIRMED") {
        setRecord(current => ({ ...current, readinessUnknown: true }));
        setNotice("Edit save outcome is unconfirmed. Reload authoritative storage before editing again. No automatic retry was sent.");
      }
      throw cause;
    }
    if (revision.proposalId) setResolvedProposals((items) => [...items, revision.proposalId]);
    setRecord({ ...next, readinessUnknown: true }); setProposal(null); setConditionMode(null); setAddingReturn(false); setWrappingCollection(false); setWrappingProtected(false); setAddingAnalysis(false); setAddingAgent(false); setInsertTarget(null); setNotice("Draft saved. Publication and execution are separate actions."); onChatChanged?.();
    try { await load(); } catch { setNotice("Draft saved, but readiness could not be refreshed. Reload before publishing or running."); }
  };
  const beginMove = id => { select(id); setInsertTarget(null); setMoving({ nodeId: id, workflowId, baseVersion: record.version, baseHash: record.contentHash }); };
  const previewMove = (id, placementKey) => {
    if (busy || record.readinessUnknown || moving && (moving.baseVersion !== record.version || moving.baseHash !== record.contentHash)) return;
    try {
      const change = movePlacementPreview(placementModel, id, placementKey);
      setProposal({ nodeId: id, baseVersion: record.version, baseHash: record.contentHash, ...change }); setMoving(null);
    } catch (cause) { setError(message(cause)); }
  };
  const renderMoveHandle = id => canEdit && arranging && placementModel.valid && placementModel.nodes.has(id) ? <><FlowMoveHandle entry={placementModel.nodes.get(id)} revision={{ workflowId, baseVersion: record.version, baseHash: record.contentHash }} disabled={busy || record.readinessUnknown || Boolean(pendingProposal)} onBegin={beginMove} />{pendingProposal?.movedNodeIds?.includes(id) && <span className="ml-2 text-[10px] text-primary">Included in move</span>}</> : null;
  const renderPlacement = (scopeKey, beforeId) => {
    const target = placementModel.placements.find(item => item.scopeKey === scopeKey && item.beforeNodeId === beforeId);
    return target ? <FlowPlacementPoint key={target.key} target={target} model={placementModel} moving={moving} revision={{ workflowId, baseVersion: record.version, baseHash: record.contentHash }} disabled={busy || record.readinessUnknown || Boolean(pendingProposal)} onInsert={value => { setMoving(null); setInsertTarget({ target: value, workflowId, baseVersion: record.version, baseHash: record.contentHash }); }} onMove={previewMove} /> : null;
  };
  const attemptRun = async (input = runInput, startOptions = {}) => {
    if (!canControl || busy || record.readinessUnknown || runPending.current) return null;
    if (blockingProposal) { setNotice("Apply or discard the preview before running. Runs use the saved published workflow, not browser edits."); return; }
    if (submittingRun || unconfirmedRun || recovery.pending || recovery.checking || runActive || ["RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(shownRun?.status)) return;
    runPending.current = true; setSubmittingRun(true); setShowResults(true); setError(""); setNotice("");
    try {
      const options = record.operation_job_admission === "operation-job/v1" ? { mode: "async-operation", idempotencyKey: crypto.randomUUID() } : record.read_job_admission === "read-job-v1" ? { mode: "async-read", idempotencyKey: crypto.randomUUID() } : {};
      const admissionOptions = { ...options, ...(startOptions.startRevision ? { startRevision: startOptions.startRevision } : record.start_revision ? { startRevision: record.start_revision } : {}), ...(actorId ? { expectedActorId: actorId } : {}) };
      const result = await workflowService.run(workflowId, input, ...(Object.keys(admissionOptions).length ? [admissionOptions] : []));
      if (typeof result?.id !== "string" || !result.id.trim() || result.workflowId && result.workflowId !== workflowId) throw new Error("The original run receipt could not be confirmed.");
      setRun(result); setShowResults(true);
      try { setTimeline(await executionService.getTimeline(result.id)); } catch { setNotice("Run admitted, but its timeline could not be refreshed. Follow the saved run ID; nothing was restarted."); }
      return result;
    } catch (cause) {
      const executionId = cause?.response?.data?.meta?.executionId;
      if (executionId) {
        try { const result = await executionService.get(executionId); setRun(result); setShowResults(true); setTimeline(await executionService.getTimeline(executionId)); return result; }
        catch { setUnconfirmedRun(true); setNotice(`Run ${executionId} was recorded, but its evidence could not be loaded. Open Execution History before starting another run.`); }
      } else if (cause?.runAdmissionUnconfirmed ?? (!cause?.response || cause.response.status >= 500)) { setUnconfirmedRun(true); setNotice("The run response was not received. Its outcome is unconfirmed; check Execution History before starting another run. No automatic retry was sent."); }
      setError(message(cause));
      return null;
    } finally { runPending.current = false; setSubmittingRun(false); }
  };
  if (!record) return <div className="p-5"><p className="text-xs text-gray-500">Loading saved workflow…</p>{error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}<button className={button} onClick={() => perform(load)}>Reload</button></div>;
  const runInputsDisabled = !canControl || busy || record.readinessUnknown || blockingProposal || submittingRun || recovery.checking || recovery.pending || unconfirmedRun || runActive || ["RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(shownRun?.status);
  const cannotRun = runInputsDisabled || !record.can_attempt_run;
  return <div className="relative flex min-h-0 flex-1 flex-col">
    {simple && pendingProposal && <section aria-label="Pending workflow change" className="shrink-0 border-b border-primary/20 bg-primary/5 px-3 py-3 text-xs">
      <p className="font-semibold">{staleProposal ? "An older change proposal is available" : "New changes are waiting for review"}</p>
      <p className="mt-1 leading-5">The canvas shows saved draft v{record.version}, not the proposed changes. {staleProposal ? "This older proposal cannot change or block the current saved workflow. Request a fresh proposal if you want to edit it." : "Review the proposal, then save it to update the canvas. Saving does not publish or run it."}</p>
      {pendingProposal.validation?.passed === false && <p className="mt-1 text-amber-700 dark:text-amber-300">The proposal still has issues. Saving it will not make the workflow ready to run.</p>}
      <button type="button" disabled={busy || record.readinessUnknown || staleProposal || !canEdit} onClick={() => setShowSaveDialog(true)} className="mt-2 rounded-md border border-primary/30 px-3 py-2 font-semibold text-primary disabled:opacity-50">Review proposed changes</button>
    </section>}
    {docked && workspace.chatWorkflowHost && createPortal(<section aria-label="Chat workflow actions" className="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 truncate text-xs font-semibold" title={preview.name}>{preview.name} <span className="font-normal text-gray-500">· saved draft v{record.version}</span></p>
        <button type="button" className={`${button} border border-gray-200 dark:border-gray-700`} disabled={!canEdit || !pendingProposal || busy || record.readinessUnknown || staleProposal} onClick={() => setShowSaveDialog(true)} title={pendingProposal ? "Review and save this exact change" : "This draft is already saved. Request or preview a change to save another revision."}>Save draft</button>
        <button type="button" className={`${button} bg-primary text-white hover:bg-primary/90`} disabled={!canControl || busy || record.readinessUnknown || blockingProposal || submittingRun || recovery.checking || recovery.pending || unconfirmedRun || runActive || ["RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(shownRun?.status)} onClick={() => setShowRunDialog(true)} title={!record.can_attempt_run ? "Check what is needed before this workflow can run" : "Review inputs and start the published workflow"}>{submittingRun ? "Starting…" : runActive ? "Running…" : "Run workflow"}</button>
        <button type="button" className={`${button} text-primary`} aria-expanded={showResults} onClick={() => setShowResults(value => !value)}>{showResults ? "Hide results" : `Results${shownRun ? ` · ${shownRun.status}` : ""}`}</button>
      </div>
      <RunAdmissionRecoveryPanel recovery={recovery} execution={shownRun} onReleased={() => { setRun(null); setTimeline([]); setUnconfirmedRun(false); setNotice("The recorded terminal run was reviewed. A new run requires an explicit click."); }} />
      {showResults && <WorkflowResults key={`${actorId}:${workflowId}`} workflowId={workflowId} execution={shownRun} monitor={monitor} loading={submittingRun || recovery.checking} />}
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-gray-500">{notice}</p>}
    </section>, workspace.chatWorkflowHost, "chat-workflow-actions")}
    <WorkflowRunDialog open={showRunDialog} inline={showRunDialog === "canvas"} workflowId={workflowId} initialRecord={record} onClose={() => setShowRunDialog(false)} onRun={attemptRun} disabled={runInputsDisabled} error={error} onReadinessChanged={setRecord}
      disabledReason={blockingProposal ? "Review and save or discard the pending workflow change before starting a run." : runActive ? "This workflow already has an active run. Check its results instead of starting it again." : !canControl ? "Your account cannot start this workflow." : recovery.pending || unconfirmedRun ? "A previous run is unconfirmed. Recover its original status before starting another run." : "A workflow action or recovery check is pending. Finish it, then recheck readiness."}
      onPublishReviewed={canEdit && !runInputsDisabled ? async revision => {
        if (busy || blockingProposal || record.readinessUnknown) throw new Error("Finish the pending workflow review before publishing.");
        setBusy(true);
        try {
          const fresh = await workflowService.readiness(workflowId);
          if (fresh.version !== revision.version || fresh.contentHash !== revision.contentHash) { setRecord(fresh); throw new Error("The saved draft changed. Recheck readiness and review the latest draft before publishing."); }
          if (!fresh.validation?.passed || fresh.readinessUnknown) { setRecord(fresh); throw new Error("The current draft still needs validation or tool review. Resolve those issues before publishing."); }
          await workflowService.publish(workflowId, "Explicitly reviewed publication from workflow input panel", fresh);
          const next = await load();
          await onChatChanged?.();
          return next;
        } finally { setBusy(false); }
      } : undefined}
      beforeInputs={showRunDialog === "canvas" ? <RunAdmissionRecoveryPanel recovery={recovery} execution={shownRun} onReleased={() => { setRun(null); setTimeline([]); setUnconfirmedRun(false); setNotice("The recorded terminal run was reviewed. A new run requires an explicit click."); }} /> : null}
      onHelp={workspace?.requestWorkflowHelp ? text => { if (showRunDialog !== "canvas") setShowRunDialog(false); workspace.requestWorkflowHelp(workflowId, text); } : undefined}
      onReview={workspace?.openCanvasTools ? () => { if (showRunDialog !== "canvas") setShowRunDialog(false); workspace.openCanvasTools(); } : undefined} />
    <WorkflowDialog open={showSaveDialog && Boolean(pendingProposal)} title="Save workflow draft" onClose={() => setShowSaveDialog(false)} busy={busy}>
      {pendingProposal && <div className="space-y-4 text-sm"><p>{pendingProposal.summary || `Review the change to ${pendingProposal.nodeId || "this workflow"}.`}</p><p className="text-xs text-gray-500">Save this exact proposal to draft v{pendingProposal.baseVersion + 1}. Saving does not publish, run or approve any ERP transaction.</p>
        <details><summary className="cursor-pointer text-primary">Before</summary><ReadableValue value={pendingProposal.before} /></details><div><p className="mb-2 font-semibold">Proposed change</p><ReadableValue value={pendingProposal.after} /></div>
        {staleProposal && <p role="alert" className="text-amber-700">The saved revision changed. Discard this proposal and request a fresh one.</p>}
        {pendingProposal.validation?.passed === false && <p role="alert" className="text-amber-700">This can only be saved as a blocked draft. Resolve its validation issues before publishing or running.</p>}
        {error && <p role="alert" className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => setShowSaveDialog(false)}>Cancel</button><button type="button" className={`${button} bg-primary text-white hover:bg-primary/90`} disabled={busy || record.readinessUnknown || staleProposal || !canEdit} onClick={() => perform(async () => { await save(pendingProposal.command, { version: pendingProposal.baseVersion, contentHash: pendingProposal.baseHash, proposalId: pendingProposal.id }); setShowSaveDialog(false); })}>Save changes to draft</button></div>
      </div>}
    </WorkflowDialog>
    {docked && <div aria-label="Current canvas draft status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-200 bg-white px-3 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-darkBackground">
      <span>Draft v{record.version} · {preview.steps.length} {preview.steps.length === 1 ? "step" : "steps"}</span>
      <span className={record.validation?.passed ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>{record.readinessUnknown ? "Readiness unavailable" : record.validation?.passed ? "Ready for review" : "Needs fixes · not ready to run"}</span>
      {!record.validation?.passed && <WorkflowFixButton workflowId={workflowId} requirements={preview.metadata?.unresolved_requirements} errors={record.validation?.errors} busy={busy || !canEdit || record.readinessUnknown} />}
      <button type="button" onClick={workspace.openCanvasTools} className="ml-auto font-medium text-primary">Review draft controls</button>
    </div>}
    {shownRun && <WorkflowRunApproval ref={approvalRef} key={`${actorId || ""}:${shownRun.id}`} execution={shownRun} onChanged={monitor.refresh} />}
    {inTools(<div className={docked ? "mb-4 border-b border-gray-200 pb-4 dark:border-gray-800" : "border-b border-gray-200 px-5 py-4 dark:border-gray-800"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{preview.name}</h3>
          {!simple && <p className="mt-1 text-[11px] leading-4 text-gray-500">Review the steps below. Publishing and running each require your explicit action.</p>}
        </div>
        <span className="shrink-0 rounded-full border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-gray-700">Revision {record.version}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
        <span className={`rounded-full px-2 py-1 font-medium ${record.validation?.passed ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"}`}>{record.validation?.passed ? "Ready for review" : "Needs fixes"}</span>
        <span className="rounded-full bg-gray-100 px-2 py-1 font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">{record.published ? record.compilation?.state === "BLOCKED" || !record.validation?.passed ? "Published · blocked" : "Published" : "Draft only"}</span>
        <span className="rounded-full bg-gray-100 px-2 py-1 font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">{record.bridge === "discovery_available" ? "ERP tools found · final check required" : "ERP not connected"}</span>
      </div>
      <WorkflowProgress record={record} shownRun={shownRun} workflowId={workflowId} />
      {(!simple || shownRun?.status !== "DONE") && <p className="mt-3 text-xs text-gray-600 dark:text-gray-300"><span className="font-semibold">Next:</span> {!record.validation?.passed ? "Open the issues below and fix the draft." : !record.published ? "Review the steps, then publish only when you are satisfied." : shownRun?.status === "DONE" && snapshotMatches ? "Select a node to review its answer, or choose Schedule for automatic runs." : shownRun?.status === "AWAITING_APPROVAL" ? "An assigned reviewer needs to approve the waiting action." : runActive ? "Follow the highlighted step while the workflow runs." : "Confirm the inputs and permissions before starting a run."}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        <button className={button} disabled={busy} onClick={() => perform(load)} aria-label="Reload workflow"><Icon icon="lucide:refresh-cw" /></button>
        <button className={button} aria-expanded={showHistory} disabled={busy} onClick={() => setShowHistory(value => !value)}><Icon icon="lucide:history" />Edit history</button>
        {canEdit && <><button className={button} aria-label="Undo workflow edit" disabled={busy || record.readinessUnknown || !record.editHistory?.undoTarget} onClick={() => perform(() => save({ type: "undoDraft", versionId: record.editHistory.undoTarget }))}><Icon icon="lucide:undo-2" /></button>
          <button className={button} aria-label="Redo workflow edit" disabled={busy || record.readinessUnknown || !record.editHistory?.redoTarget} onClick={() => perform(() => save({ type: "redoDraft", versionId: record.editHistory.redoTarget }))}><Icon icon="lucide:redo-2" /></button>
          <button className={button} disabled={busy} onClick={() => setAdding((value) => !value)}><Icon icon="lucide:plus" />Add node</button>
          {!simple && <>{supportsModelInsertion && <><button className={button} disabled={busy || record.readinessUnknown || !placementModel.valid || Boolean(pendingProposal)} onClick={() => addingAnalysis ? setAddingAnalysis(false) : openModelInsertion("analysis")}><Icon icon="lucide:brain-circuit" />Add analysis</button>
          <button className={button} disabled={busy || record.readinessUnknown || !placementModel.valid || Boolean(pendingProposal) || agentReadActions.length === 0} onClick={() => addingAgent ? setAddingAgent(false) : openModelInsertion("agent")}><Icon icon="lucide:bot" />Add bounded agent</button></>}
          <button className={button} disabled={busy || record.readinessUnknown || preview.error} onClick={() => setConditionMode(value => value === "add" ? null : "add")}>Add condition</button>
          <button className={button} disabled={busy || record.readinessUnknown || preview.error || !supportsReturnInsertion} onClick={() => setAddingReturn(value => !value)}>Add return</button>
          <button className={button} aria-pressed={arranging} disabled={busy || record.readinessUnknown || !placementModel.valid || Boolean(pendingProposal)} onClick={() => { setArranging(value => !value); setMoving(null); setInsertTarget(null); }}>Arrange flow</button></>}
          <button className={`${button} ml-auto border border-gray-200 dark:border-gray-700`} disabled={busy || record.readinessUnknown || Boolean(pendingProposal) || !record.validation?.passed || record.published && record.compilation?.state !== "BLOCKED"} onClick={() => perform(async () => { await workflowService.publish(workflowId, "Explicitly reviewed in chat workspace", record); setNotice("Draft published. Execution has not been requested."); await load(); await onChatChanged?.(); })}>{record.published && record.compilation?.state === "BLOCKED" ? "Republish reviewed draft" : "Publish reviewed draft"}</button></>}
      </div>
    </div>, "editor-heading")}
    <div className={docked ? "flex min-h-0 flex-1 flex-col" : "flex-1 overflow-auto px-5 py-5"}>
      {inTools(<div className="space-y-3">
      {canEdit && pendingProposal && <p role="status" className="mb-4 text-xs text-amber-700 dark:text-amber-400">Apply or discard the pending change before publishing. Publishing uses the saved draft only.</p>}
      {notice && <p role="status" className="mb-4 text-xs text-gray-500">{notice}</p>}
      {showHistory && <WorkflowEditHistory key={`${workflowId}:${record.version}:${record.contentHash}`} workflowId={workflowId} record={record} canEdit={canEdit} busy={busy} onRestore={command => perform(() => save(command))} />}
      {error && <div role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30">{error}{pendingProposal && <p className="mt-1">Your unsaved proposal is retained. Reload if another edit changed the draft.</p>}</div>}
      {preview.error && <p role="alert" className="text-xs text-amber-700">{preview.error}</p>}
      {arranging && <div className="workspace-reveal mb-4 text-xs text-gray-500"><p>Select Move or drag its handle to a position. Conditions and collections move with their contents. Review before saving.</p>{moving && <p role="status" className="mt-2">Placing {moving.nodeId} · choose a highlighted position.<button className={button} onClick={() => setMoving(null)}>Cancel move</button></p>}{!placementModel.valid && <p role="alert" className="mt-2">{placementModel.error}</p>}</div>}
      {insertTarget && <CanvasInsertionForm key={`${record.version}:${record.contentHash}:${insertTarget.key}`} target={insertTarget} disabled={busy || record.readinessUnknown || Boolean(pendingProposal)} onPreview={previewChange} onCancel={() => setInsertTarget(null)} onModel={openModelInsertion} allowAnalysis={supportsModelInsertion} allowAgent={supportsModelInsertion && agentReadActions.length > 0} allowReturn={supportsReturnInsertion} />}
      {(addingAnalysis || addingAgent) && modelInsertionStale && <p role="alert" className="mb-3 text-xs text-amber-700">The draft changed since this model editor opened. Your inputs are retained. Close and reopen the editor to deliberately select a position in the current revision.</p>}
      {!!record.validation?.errors?.length && <details className="mb-4 text-xs"><summary className="cursor-pointer text-amber-700">Validation issues ({record.validation.errors.length})</summary><ul className="mt-2 space-y-1 text-gray-500">{record.validation.errors.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
      {!!record.issues?.length && <details className="mb-4 text-xs" open><summary className="cursor-pointer text-amber-700">Execution readiness issues ({record.issues.length})</summary><ul className="mt-2 space-y-1 text-gray-500">{record.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
      {(shownRun || monitor.denied) && (!simple || shownRun?.status !== "DONE" || !snapshotMatches) && <div className="mb-5"><ExecutionRunControls key={shownRun?.id || "unavailable"} execution={shownRun} canControl={canControl} monitor={monitor} onReviewApproval={() => approvalRef.current?.open()} />
        {shownRun && !snapshotMatches && <p className="mt-2 text-[10px] text-gray-500">These answers belong to a different or unverified run snapshot, not the current draft.</p>}
      </div>}
      {adding && <form className="mb-5 space-y-2 border-b border-gray-200 pb-4 dark:border-gray-700" onSubmit={(event) => { event.preventDefault();
        const node = { id: newId, action: newAction, ...(authoring?.connectionChoices?.length ? { connection_id: newConnectionId || primaryConnectionId } : {}), parameters: {} };
        previewChange(newId, { type: "addNode", node, beforeNodeId: null, ...branchDestination(addScope, authoring?.controlFlow) }, "No node at this destination", node);
        setAdding(false); setNewId(""); setNewAction("");
      }}>
        <input className={input} aria-label="New node ID" placeholder="Unique node ID" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" value={newId} onChange={(event) => setNewId(event.target.value)} required />
        {!!authoring?.connectionChoices?.length && <select className={input} aria-label="New node ERPBridge connection" value={newConnectionId || primaryConnectionId} onChange={event => setNewConnectionId(event.target.value)}>{authoring.connectionChoices.map(item => <option key={item.id} value={item.id}>{item.id}{item.primary ? " · primary" : ""}</option>)}</select>}
        <input className={input} aria-label="New node tool" placeholder="Exact registered tool name" value={newAction} onChange={(event) => setNewAction(event.target.value)} required />
        {authoring?.controlFlow && <ScopeSelect flow={authoring.controlFlow} value={addScope} onChange={setAddScope} label="New node destination" />}
        <button className={`${button} bg-primary/10 text-primary`} disabled={busy || record.readinessUnknown || Boolean(pendingProposal)}>Add draft node</button><p className="text-[10px] text-gray-500">Creates a local preview first. Apply explicitly to save; fill required parameters in the inspector. Unavailable tools remain blocked drafts.</p>
      </form>}
      {addingAnalysis && <form aria-label="Create analysis node" className="workspace-reveal mb-5 space-y-3 border-y border-primary/25 py-4" onSubmit={event => { event.preventDefault(); previewModelInsertion("addAnalysis",
        { id: newAnalysisId, kind: "analysis", description: "Structured analysis", instruction: newAnalysisInstruction, input: newAnalysisInput,
          output_schema: newAnalysisSchema, data_class: newAnalysisClass, model: newAnalysisModel, max_input_items: 200, max_input_chars: 20000, max_output_tokens: 2048 }, newAnalysisBefore,
        { id: newAnalysisId, type: "Structured analysis", input: newAnalysisInput, dataClass: newAnalysisClass, model: newAnalysisModel || "Reviewed provider default" }); }}>
        <div><h4 className="text-xs font-semibold">Add structured analysis</h4><p className="mt-1 text-[10px] leading-4 text-gray-500">Place one bounded model transformation after its source read and before the effect that consumes it.</p></div>
        <input aria-label="New analysis ID" className={input} value={newAnalysisId} onChange={event => setNewAnalysisId(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" placeholder="Unique stable analysis ID" maxLength={64} required />
        <textarea aria-label="New analysis instruction" className={`${input} min-h-20 resize-y`} value={newAnalysisInstruction} onChange={event => setNewAnalysisInstruction(event.target.value)} placeholder="What should the model derive from the acknowledged input?" maxLength={4000} required />
        <ModelInputFields value={newAnalysisInput} onChange={setNewAnalysisInput} label="New analysis input" />
        <div className="grid gap-3 sm:grid-cols-2"><select aria-label="New analysis data class" className={input} value={newAnalysisClass} onChange={event => setNewAnalysisClass(event.target.value)}><option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option></select><input aria-label="New analysis model" className={input} value={newAnalysisModel} onChange={event => setNewAnalysisModel(event.target.value)} placeholder="Reviewed provider default" maxLength={256} /></div>
        <ModelInsertionPosition model={placementModel} value={newAnalysisBefore} onChange={setNewAnalysisBefore} label="New analysis position" />
        <SchemaContractFields schema={newAnalysisSchema} onChange={setNewAnalysisSchema} label="Structured answer contract" />
        <div className="flex flex-wrap gap-2"><button className={`${button} text-primary`} disabled={modelInsertionDisabled}>Preview analysis node</button><button type="button" className={button} onClick={() => setAddingAnalysis(false)}>Cancel</button></div>
      </form>}
      {addingAgent && <form aria-label="Create agent node" className="workspace-reveal mb-5 space-y-3 border-y border-primary/25 py-4" onSubmit={event => { event.preventDefault(); previewModelInsertion("addAgent",
        { id: newAgentId, kind: "agent", ...(authoring?.connectionChoices?.length ? { connection_id: newAgentConnectionId || primaryConnectionId } : {}), description: "Bounded runtime agent", instruction: newAgentInstruction, input: newAgentInput,
          allowed_actions: [newAgentAction], output_schema: newAgentSchema, completion_predicate: { path: ["complete"], equals: true }, data_class: newAgentClass,
          model: newAgentModel, max_input_items: 200, max_input_chars: 20000, max_output_tokens: 1024, max_total_tokens: 4096, max_rounds: 4,
          max_tool_calls: 8, max_wall_time_ms: 30000, max_concurrency: 1 }, newAgentBefore,
        { id: newAgentId, type: "Bounded runtime agent", input: newAgentInput,
          allowedReads: [newAgentAction], completion: "complete equals true", dataClass: newAgentClass, model: newAgentModel || "Reviewed provider default" }); }}>
        <div><h4 className="text-xs font-semibold">Add bounded runtime agent</h4><p className="mt-1 text-[10px] leading-4 text-gray-500">The model may dynamically choose only the selected reviewed read. Any later email or ERP effect stays a separate independently approved node.</p></div>
        <input aria-label="New agent ID" className={input} value={newAgentId} onChange={event => setNewAgentId(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" placeholder="Unique stable agent ID" maxLength={64} required />
        {!!authoring?.connectionChoices?.length && <select aria-label="New agent ERPBridge connection" className={input} value={agentConnectionId} onChange={event => { setNewAgentConnectionId(event.target.value); setNewAgentAction(""); }}>{authoring.connectionChoices.map(item => <option key={item.id} value={item.id}>{item.id}{item.primary ? " · primary" : ""}</option>)}</select>}
        <textarea aria-label="New agent instruction" className={`${input} min-h-20 resize-y`} value={newAgentInstruction} onChange={event => setNewAgentInstruction(event.target.value)} placeholder="What evidence should the bounded agent gather and return?" maxLength={4000} required />
        <ModelInputFields value={newAgentInput} onChange={setNewAgentInput} label="New agent input" />
        <label className="block text-xs text-gray-500">Allowed reviewed read<select aria-label="New agent allowed action" className={input} value={newAgentAction} onChange={event => setNewAgentAction(event.target.value)} required><option value="" disabled>Select one exact read capability</option>{agentReadActions.map(action => <option key={action} value={action}>{action}</option>)}</select></label>
        <div className="grid gap-3 sm:grid-cols-2"><select aria-label="New agent data class" className={input} value={newAgentClass} onChange={event => setNewAgentClass(event.target.value)}><option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option></select><input aria-label="New agent model" className={input} value={newAgentModel} onChange={event => setNewAgentModel(event.target.value)} placeholder="Reviewed provider default" maxLength={256} /></div>
        <ModelInsertionPosition model={placementModel} value={newAgentBefore} onChange={setNewAgentBefore} label="New agent position" />
        <SchemaContractFields schema={newAgentSchema} onChange={setNewAgentSchema} label="Structured completion contract" />
        <p className="text-[10px] text-gray-500">The initial completion predicate is <span className="font-mono">complete equals true</span>. Select the node after adding it to edit all budgets, allowed reads and completion fields.</p>
        <div className="flex flex-wrap gap-2"><button className={`${button} text-primary`} disabled={modelInsertionDisabled || !newAgentAction}>Preview agent node</button><button type="button" className={button} onClick={() => setAddingAgent(false)}>Cancel</button></div>
      </form>}
      {conditionMode && <form aria-label="Create condition" className="mb-5 space-y-3 border-b border-gray-200 pb-4 dark:border-gray-700" onSubmit={event => {
        event.preventDefault();
        const command = conditionMode === "wrap" && node ? { type: "wrapNode", nodeId: node.id, conditionId, predicate: conditionPredicate, branch: conditionBranch } : { type: "addCondition", conditionId, predicate: conditionPredicate, beforeNodeId: null, ...branchDestination(conditionScope, authoring?.controlFlow) };
        previewChange(conditionId, command, conditionMode === "wrap" && node ? node.source : "No condition at this destination", { conditionId, predicate: conditionPredicate, placement: conditionMode === "wrap" && node ? `${node.id} → ${conditionBranch === "then" ? "If yes" : "If no"}` : conditionScope === "root" ? "Main sequence end · empty paths" : `${conditionScope.replace(":then", " · If yes").replace(":else", " · If no")} · empty paths` });
      }}>
        <h4 className="text-xs font-semibold">{conditionMode === "wrap" && node ? `Wrap ${node.id} in a condition` : "Create empty condition paths"}</h4>
        <input aria-label="New condition ID" className={input} value={conditionId} onChange={event => setConditionId(event.target.value)} placeholder="Unique stable condition ID" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" required />
        <ConditionFields value={conditionPredicate} onChange={setConditionPredicate} />
        {conditionMode === "wrap" && node ? <select aria-label="Wrapped node branch" className={input} value={conditionBranch} onChange={event => setConditionBranch(event.target.value)}><option value="then">Put selected action in If yes</option><option value="else">Put selected action in If no</option></select> : <ScopeSelect flow={authoring?.controlFlow} value={conditionScope} onChange={setConditionScope} label="New condition destination" />}
        <button className={button} disabled={busy}>Preview new condition</button><button type="button" className={button} onClick={() => setConditionMode(null)}>Cancel condition creation</button>
      </form>}
      {!simple && <p className="mb-4 text-[10px] leading-4 text-gray-500">{flowProtectedGroups(authoring?.controlFlow).length ? "Protected workflow · body and error handler are separate scopes. Only a reviewed ERP resource-not-found can select a handler. Saved group values do not change the failed lookup or approve an effect. Check readiness before running." : authoring?.executionProfile === "decision-operation-v1" ? "Governed decision flow · each run selects one boolean path. Unselected nodes do not run; selected effects require independent approval. Branch outputs remain in scope. Calendar activation additionally requires complete report evidence before every effect." : authoring?.controlFlow ? "Structured read flow · exactly one path per boolean condition. Branch outputs remain in scope." : preview.metadata?.controlFlow !== undefined ? "Structural view is unavailable. These are source declarations, not a confirmed execution layout; reload or repair the saved structure." : "Source-order flow · conditions and approvals are preserved, not inferred as branch paths."}</p>}
      {addingReturn && <form aria-label="Create return" className="mb-5 space-y-3 border-b pb-4" onSubmit={event => { event.preventDefault(); previewChange(returnId, { type: "addReturn", nodeId: returnId, output: returnOutput, beforeNodeId: null, ...branchDestination(returnScope, authoring?.controlFlow) }, "No return at this destination", { id: returnId, output: returnOutput, destination: returnScope }); }}><h4 className="text-xs font-semibold">Declare workflow return</h4><input aria-label="New return ID" className={input} value={returnId} onChange={event => setReturnId(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" placeholder="Unique stable return ID" required /><ScopeSelect flow={authoring?.controlFlow} value={returnScope} onChange={setReturnScope} label="New return destination" /><ReadValueFields value={returnOutput} onChange={setReturnOutput} /><button disabled={busy} className={button}>Preview new return</button><button type="button" className={button} onClick={() => setAddingReturn(false)}>Cancel return creation</button></form>}
      {iterationModel && !iterationModel.valid && <p role="alert" className="mb-3 text-xs text-amber-700">{iterationModel.error}</p>}
      </div>, "editor-forms")}
      <WorkflowMiniCanvas simple={simple} viewReset={viewReset}
        onPrepareInputs={authoring?.inputSchema?.type === "object" && Object.keys(authoring.inputSchema.properties || {}).length ? () => setShowRunDialog("canvas") : undefined}
        busy={busy || record.readinessUnknown}
        onContinueChat={canEdit && onFocusChat ? () => { setSelected(""); writeWorkspaceValue(selectionStorageKey ? `${selectionStorageKey}.node` : null, ""); if (workspace?.requestWorkflowHelp) workspace.requestWorkflowHelp(workflowId, "Help me fix this selected workflow. Load its current saved draft, validation issues and unresolved requirements. Check the latest available ERP tools rather than relying on old missing-tool messages. Ask only for genuinely missing business details, then prepare the changes for my review. Do not publish, run or send anything yet."); else onFocusChat(); } : undefined}
        approvalWaiting={snapshotMatches && shownRun?.status === "AWAITING_APPROVAL"}
        pendingApprovalNode={snapshotMatches && shownRun?.status === "AWAITING_APPROVAL" ? shownRun.pendingApproval?.stepId : undefined}
        approvalNodes={authoring?.nodes?.filter(item => item.requiresIndependentApproval === true).map(item => item.nodeId)}
        onReviewApproval={() => approvalRef.current?.open()}
        savedDraft emptyDescription={preview.description} unresolvedRequirements={preview.metadata?.unresolved_requirements} onOpenControls={docked ? workspace.openCanvasTools : undefined} run={snapshotMatches && !iterationModel ? shownRun : undefined} declaredStructure={preview.metadata?.controlFlow !== undefined} flow={authoring?.controlFlow} steps={preview.steps} selectedId={selected} onSelectCondition={select} renderPlacement={canEdit && arranging && placementModel.valid ? renderPlacement : undefined} renderMoveHandle={renderMoveHandle} iterations={iterationModel} timeline={snapshotMatches ? shownTimeline : undefined} decisions={!iterationModel && snapshotMatches ? shownRun?.readProgress?.decisions : undefined} values={!iterationModel && snapshotMatches ? shownRun?.readProgress?.values : undefined} valueOutputs={!iterationModel && snapshotMatches ? shownRun?.valueOutputs : undefined} renderAction={(step, index) => {
          const attempt = !iterationModel ? shownTimeline.find((item) => item.nodeId === step.id) : undefined;
          const output = !iterationModel ? shownRun?.stepOutputs?.[step.id] ?? (attempt?.status === "FAILED" ? attempt.output : undefined) : undefined;
          const analysis = step.source.kind === "analysis", agent = step.source.kind === "agent", modelNode = analysis || agent;
          const status = snapshotMatches ? stepStatus(attempt, output !== undefined, shownRun?.status) : null;
          return <li key={step.id} className="relative">
            <button type="button" aria-pressed={node?.id === step.id} onClick={() => select(step.id)} className={`workspace-node relative z-10 flex w-full items-center gap-3 rounded-lg border bg-white px-4 py-3 text-left dark:bg-darkBackground ${node?.id === step.id ? "border-primary ring-1 ring-primary/20" : "border-gray-200 dark:border-gray-700"}`}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gray-50 text-xs text-gray-400 dark:bg-gray-900">{snapshotMatches && attempt?.status === "DONE" ? <Icon icon="lucide:check" /> : snapshotMatches && attempt?.status === "FAILED" ? <Icon icon="lucide:triangle-alert" /> : analysis ? <Icon icon="lucide:brain-circuit" /> : agent ? <Icon icon="lucide:bot" /> : String(index + 1).padStart(2, "0")}</span>
              <span className="min-w-0 flex-1"><span className="block break-words text-xs font-semibold">{step.source.description || step.id}</span><span className="mt-1 block break-words text-[10px] text-gray-500">{analysis ? "Analysis step" : agent ? "ERP assistant step" : "ERP step"} · select to review or edit</span></span>
              {status && <span aria-label={`Step status: ${status.label}`} className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-semibold ${status.tone}`}>{status.label}</span>}
              {step.source.condition && <span className="text-[9px] text-gray-500">condition</span>}
              <Icon icon="lucide:chevron-right" className="h-3 w-3 text-gray-400" />
            </button>
            {renderMoveHandle(step.id)}
            <IterationNodeEvidence key={`${iterationModel?.executionId}:${step.id}`} model={iterationModel} nodeId={step.id} />
            {output !== undefined && <NodeAnswer output={output} attempt={attempt} runId={shownRun.id} analysis={analysis} agent={agent} selected={node?.id === step.id} />}
            {attempt?.status === "FAILED" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-red-600">{snapshotMatches && flowProtectedGroups(authoring?.controlFlow).length ? "In this run, this node failed or was blocked. A declared handler may continue only after the server records its exact eligible failure. This node has no successful answer." : "In this run, this node failed or was blocked. Following nodes were not executed."}</p>}
            {attempt?.status === "UNKNOWN" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-amber-700 dark:text-amber-300">{modelNode ? "Model or bounded agent outcome unknown · no validated structured answer was saved, no later effect ran and the call is never replayed automatically." : attempt.sideEffect ? "Outcome unknown · the operation may have taken effect in ERP, but no confirmed result was saved. Reconcile before retrying. No automatic replay." : "Outcome unknown · the read may have reached ERP, but no confirmed answer was saved. No automatic replay."}</p>}
            {attempt?.reconciliation && <div className="relative z-10 ml-10 mt-2"><OperationReconciliationEvidence record={attempt.reconciliation} /></div>}
            {snapshotMatches && shownRun?.hasOperationReconciliation === true && attempt?.status === "UNKNOWN" && attempt.sideEffect && <div className="relative z-10 ml-3 mt-3 sm:ml-10"><OperationStatusQueries executionId={shownRun.id} nodeId={step.id} onHistoryChanged={monitor.refresh} /></div>}
            {attempt?.status === "AWAITING_APPROVAL" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-amber-700 dark:text-amber-300">{shownRun?.status === "AWAITING_APPROVAL" ? "Human approval required · this operation has not been dispatched." : "This checkpoint has a recorded review. Check the run outcome; approval does not confirm execution."} <button type="button" onClick={() => approvalRef.current?.open()} className="font-semibold underline">Review here</button></p>}
            {attempt?.status === "RUNNING" && output === undefined && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">{analysis ? attempt.phase === "MODEL_DISPATCH_INTENT" ? "Model dispatch recorded · waiting for one validated structured answer" : "Checking analysis input, model and egress policy" : agent ? `Bounded agent in progress · ${String(attempt.phase || "checking limits").replaceAll("_", " ").toLowerCase()}` : attempt.phase === "DISPATCH_INTENT" ? attempt.sideEffect ? "Operation dispatch recorded · waiting for a saved result" : "Read dispatch recorded · waiting for a saved answer" : "Checking this node before dispatch"}</p>}
            {attempt?.outcome === "operation-accepted" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">Tool acceptance saved · recipient delivery is not independently verified.</p>}
            {attempt?.outcome === "operation-confirmed" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">Tool-reported operation confirmation saved.</p>}
            {attempt?.outcome === "NOT_DISPATCHED" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">No dispatch was recorded for this attempt.</p>}
            {attempt?.status === "SKIPPED" && <p className="relative z-10 ml-10 mt-2 text-[10px] text-gray-500">Skipped in this run · {attempt.outcome === "AFTER_RETURN" ? `workflow returned at ${attempt.returnId}` : attempt.outcome === "BODY_SUCCEEDED" ? "protected body completed; handler not needed" : attempt.outcome === "BODY_ABORTED" ? "protected body stopped after its recorded failure" : "another branch was selected"}. This node was not called and has no answer.</p>}
          </li>;
        }} />
      {inTools(<div ref={inspectorRef} className="space-y-3">
      {node && <><details key={`${node.id}:${record.version}`} open={docked || !onNodeContext} className="mt-5 border-t border-gray-200 pt-3 text-xs dark:border-gray-700"><summary className="cursor-pointer font-medium">{node.source.kind === "analysis" ? "Analysis settings" : node.source.kind === "agent" ? "Bounded agent settings" : "Node settings"} · {node.id}</summary>{node.source.kind === "analysis" ? <AnalysisNodeInspector node={node} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${node.id}` : null} authoring={authoring?.nodes?.find(item => item.nodeId === node.id)} onPreview={(patch) => setProposal({ nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash, command: { type: "updateAnalysis", nodeId: node.id, patch }, before: node.source, after: { ...node.source, ...patch } })} /> : node.source.kind === "agent" ? <AgentNodeInspector node={node} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${node.id}` : null} authoring={authoring?.nodes?.find(item => item.nodeId === node.id)} connections={authoring?.connectionChoices} onPreview={(patch) => setProposal({ nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash, command: { type: "updateAgent", nodeId: node.id, patch }, before: node.source, after: { ...node.source, ...patch } })} /> : <NodeInspector node={node} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${node.id}` : null} authoring={authoring?.nodes?.find(item => item.nodeId === node.id)} connections={authoring?.connectionChoices} onPreview={(patch) => setProposal({ nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash, command: { type: "updateNode", nodeId: node.id, patch }, before: node.source, after: { ...node.source, ...patch } })} />}</details>
        {canEdit && <div className="mt-3 flex flex-wrap gap-1">{onFocusChat && <button className={`${button} text-primary lg:hidden`} onClick={onFocusChat}>Edit this node in chat</button>}{authoring?.controlFlow && <ScopeSelect flow={authoring.controlFlow} value={moveScope} onChange={setMoveScope} label="Move node destination" />}<button className={button} disabled={busy || record.readinessUnknown || !placementModel.valid || !authoring?.controlFlow && preview.steps.at(-1)?.id === node.id} onClick={() => previewMove(node.id, `${moveScope}|$end`)}>{authoring?.controlFlow ? "Move to selected scope end" : "Move to end"}</button>{(!["analysis", "agent"].includes(node.source.kind) || authoring?.modelNodesSupported) && <button className={button} disabled={busy} onClick={() => setConditionMode("wrap")}>Wrap node in condition</button>}<button className={`${button} text-red-600`} disabled={busy} onClick={() => setProposal({ nodeId: node.id, baseVersion: record.version, baseHash: record.contentHash, command: { type: "removeNode", nodeId: node.id }, before: node.source, after: null })}>Remove node…</button></div>}</>}
      {condition && <><ConditionInspector key={`${condition.id}:${record.version}`} node={condition} canEdit={canEdit} busy={busy} operationFlow={operationFlow} mergesSupported={authoring?.mergeNodesSupported === true} sessionId={sessionId} context={{ workflowId, nodeId: condition.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${condition.id}` : null} authoring={authoring?.conditions?.find(item => item.nodeId === condition.id)} onPreview={patch => previewChange(condition.id, { type: "updateCondition", nodeId: condition.id, patch }, condition.predicate, patch.predicate)} onMergePreview={merge => previewChange(condition.id, { type: "setConditionMerge", nodeId: condition.id, merge }, condition.merge || "No declared output", merge)} />
        {canEdit && <><button className={`${button} mt-3 text-red-600`} disabled={busy || condition.then.nodes.length > 0 || condition.else.nodes.length > 0} onClick={() => previewChange(condition.id, { type: "removeCondition", nodeId: condition.id }, condition, null)}>Remove empty condition…</button>{(condition.then.nodes.length > 0 || condition.else.nodes.length > 0) && <p className="mt-1 text-[10px] text-gray-500">Move or remove both paths' contents before removing this condition. Nothing is silently flattened.</p>}</>}
      </>}
      {returnNode && <><ReturnInspector key={`${returnNode.id}:${record.version}`} node={returnNode} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: returnNode.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${returnNode.id}` : null} authoring={authoring?.returns?.find(item => item.nodeId === returnNode.id)} onPreview={output => previewChange(returnNode.id, { type: "updateReturn", nodeId: returnNode.id, patch: { output } }, returnNode.output, output)} />{canEdit && <button disabled={busy} className={`${button} mt-3 text-red-600`} onClick={() => previewChange(returnNode.id, { type: "removeReturn", nodeId: returnNode.id }, returnNode, null)}>Remove return…</button>}</>}
      {node && !["analysis", "agent"].includes(node.source.kind) && canEdit && !operationFlow && <><button className={`${button} mt-3`} disabled={busy || record.readinessUnknown} onClick={() => setWrappingCollection(value => !value)}>Wrap node in collection</button>{wrappingCollection && <CollectionWrapForm key={`${node.id}:${record.version}`} nodeId={node.id} busy={busy} onCancel={() => setWrappingCollection(false)} onPreview={(command, before, after) => previewChange(node.id, command, before, after)} />}</>}
      {protectedGroup && <ProtectedGroupInspector key={`${protectedGroup.id}:${record.version}`} node={protectedGroup} canEdit={canEdit} busy={busy || record.readinessUnknown || Boolean(pendingProposal)} sessionId={sessionId} context={{ workflowId, nodeId: protectedGroup.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} onFocusChat={onFocusChat} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${protectedGroup.id}` : null} authoring={protectedGuidance} onPreview={patch => previewChange(protectedGroup.id, { type: "updateProtected", nodeId: protectedGroup.id, patch }, protectedGroup.output, patch.output)} onUnwrap={() => previewChange(protectedGroup.id, { type: "unwrapProtected", nodeId: protectedGroup.id }, protectedGroup, "Body contents preserved in the parent scope; empty handler removed")} />}
      {node && canEdit && <><button className={`${button} mt-3`} disabled={busy || record.readinessUnknown || Boolean(pendingProposal) || !placementModel.valid} onClick={() => setWrappingProtected(value => !value)}>Protect node with error handler</button>{wrappingProtected && <ProtectedWrapForm key={`${node.id}:${record.version}`} nodeId={node.id} busy={busy || record.readinessUnknown || Boolean(pendingProposal)} onCancel={() => setWrappingProtected(false)} onPreview={(command, before, after) => previewChange(command.protectedId, command, before, after)} />}</>}
      {collection && <CollectionInspector key={`${collection.id}:${record.version}`} node={collection} canEdit={canEdit} busy={busy} sessionId={sessionId} context={{ workflowId, nodeId: collection.id, baseVersion: record.version, baseHash: record.contentHash }} onProposal={setProposal} sharedChat={Boolean(onNodeContext)} onFocusChat={onFocusChat} draftStorageKey={selectionStorageKey ? `${selectionStorageKey}.node-prompt.${collection.id}` : null} authoring={authoring?.collections?.find(item => item.nodeId === collection.id)} onPreview={(command, before, after) => previewChange(collection.id, command, before, after)} onRemove={() => previewChange(collection.id, { type: "removeCollection", nodeId: collection.id }, collection, null)} />}
      {canEdit && pendingProposal && <section aria-label={pendingProposal.scope === "workflow" ? "Workflow change preview" : "Node change preview"} className="workspace-reveal mt-5 border-y border-primary/25 py-4">
        <h4 className="text-xs font-semibold">Review change · {pendingProposal.scope === "workflow" ? "Whole workflow" : pendingProposal.nodeId}</h4><p className="mt-1 text-[10px] text-gray-500">Based on draft v{pendingProposal.baseVersion}. {pendingProposal.scope === "workflow" ? "Review the complete proposed draft before applying. Publication, execution and scheduling are separate." : pendingProposal.command.type === "moveNode" ? "Configurations are preserved; order and scope change." : "Unrelated nodes are unchanged."}</p>
        {pendingProposal.summary && <p className="mt-2 text-xs">{pendingProposal.summary}</p>}
        {staleProposal && <p role="alert" className="mt-2 text-xs text-amber-700">This preview belongs to an older draft. Inspect the current revision, then discard and create a new preview. It cannot be applied to this revision.</p>}
        {pendingProposal.command.type === "moveNode" && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Order and scope change. Node configuration and owned contents are preserved; references and prerequisites may need repair. The backend validates on save and never silently rewires them.</p>}
        {pendingProposal.command.type === "updateProtected" && pendingProposal.command.patch.output && !pendingProposal.command.patch.onError ? <ProtectedPatchPreview proposal={pendingProposal} /> : pendingProposal.command.type === "updateCollection" ? <CollectionPatchPreview proposal={pendingProposal} /> : pendingProposal.command.type === "updateCondition" && pendingProposal.id ? <ConditionPatchPreview proposal={pendingProposal} /> : <><details className="mt-3 text-[10px]"><summary className="cursor-pointer">Before</summary><div className="mt-2 max-h-56 overflow-auto"><ReadableValue value={pendingProposal.before} /></div></details>
        <p className="mt-3 text-[10px] text-gray-500">After{pendingProposal.after === null ? " · node will be removed" : ""}</p><div className="mt-1 max-h-64 overflow-auto"><ReadableValue value={pendingProposal.after} /></div></>}
        {pendingProposal.validation && <p className="mt-2 text-[10px] text-gray-500">{pendingProposal.validation.passed ? "Proposal validation passed · not published" : "Proposal has validation issues · may only be saved as a blocked draft"}</p>}
        {!pendingProposal.validation && <p className="mt-2 text-[10px] text-gray-500">Local preview only · not saved to the database. Apply to draft validates and saves it. Refreshing or closing this page loses this preview. Nothing executes.</p>}
        {!!pendingProposal.validation?.errors?.length && <details className="mt-2 text-xs"><summary className="cursor-pointer text-amber-700">Proposal issues ({pendingProposal.validation.errors.length})</summary><ul className="mt-2 space-y-1 text-gray-500">{pendingProposal.validation.errors.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
        {pendingProposal.scope === "workflow" && <details className="mt-3 text-xs"><summary className="cursor-pointer">Complete proposed workflow source</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{pendingProposal.command.yaml}</pre></details>}
        <div className="mt-3 flex gap-2"><button className={`${button} bg-primary text-white hover:bg-primary/90`} disabled={busy || record.readinessUnknown || staleProposal} onClick={() => perform(() => save(pendingProposal.command, { version: pendingProposal.baseVersion, contentHash: pendingProposal.baseHash, proposalId: pendingProposal.id }))}>Apply to draft</button><button className={button} disabled={busy || record.readinessUnknown} onClick={() => perform(async () => { if (pendingProposal.id) { await workflowService.command(workflowId, record, { type: "discardProposal", proposalId: pendingProposal.id }); setResolvedProposals((items) => [...items, pendingProposal.id]); onChatChanged?.(); } setProposal(null); setNotice("Proposal discarded. The workflow was not changed."); })}>Discard</button></div>
      </section>}
      <RunAdmissionRecoveryPanel recovery={recovery} execution={shownRun} onReleased={() => { setRun(null); setTimeline([]); setUnconfirmedRun(false); setNotice("The recorded terminal run was reviewed. A new run requires an explicit click."); }} />
      <PublishedWorkflowRunForm record={record} authoring={authoring} runInput={runInput} onInput={setRunInput} buttonClass={button} onRun={() => attemptRun(runInput)} submitting={submittingRun || recovery.checking} unconfirmed={unconfirmedRun && !recovery.run} disabled={cannotRun} />
      <ReadSimulationPanel workflowId={workflowId} record={record} steps={preview.steps} canControl={canControl} disabled={busy || record.readinessUnknown || Boolean(preview.error)} />
      {shownRun && <div className="mt-4 border-t border-gray-200 pt-3 text-[10px] text-gray-500 dark:border-gray-700"><p>Run {shownRun.id} · {shownRun.status} · published v{shownRun.workflowSnapshot?.version ?? "unknown"}</p><p className="mt-1">Answers belong to this run snapshot, not unsaved edits.</p>{shownRun.agentSummary && <p className="mt-2">{shownRun.agentSummary}</p>}<a href={`/executions/${encodeURIComponent(shownRun.id)}`} className="mt-2 inline-block text-primary">Open full run evidence</a></div>}
      {shownRun?.hasOperationReconciliation === true && !snapshotMatches && <div className="mt-4"><OperationStatusQueries executionId={shownRun.id} onHistoryChanged={monitor.refresh} /></div>}
      <WorkflowSourcePreview source={record.yaml} />
      {busy && <p role="status" className="mt-4 text-xs text-gray-500">Working… no completed result is assumed.</p>}
      </div>, "editor-inspector")}
    </div>
  </div>;
}
