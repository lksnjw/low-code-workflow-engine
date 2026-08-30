import { MarkerType } from "@xyflow/react";

const CANVAS_WORKFLOW_KEY = "workflow.pendingCanvasWorkflow";
const CHAT_EDIT_KEY = "workflow.pendingChatEdit";

const actionMeta = {
  "procurement.validate_vendor": {
    label: "Validate Vendor",
    iconKey: "UserCheck",
    role: "procurement_officer",
    tone: "emerald",
  },
  "policy.check_policy_limit": {
    label: "Policy Check",
    iconKey: "ShieldCheck",
    role: "policy",
    tone: "blue",
  },
  "approval.request_human_approval": {
    label: "Human Approval",
    iconKey: "UserSearch",
    role: "procurement_manager",
    tone: "amber",
  },
  "procurement.create_purchase_order": {
    label: "Create PO",
    iconKey: "ShoppingCart",
    role: "procurement_officer",
    tone: "purple",
  },
  "audit.write_audit_log": {
    label: "Audit Log",
    iconKey: "FileCheck2",
    role: "auditor",
    tone: "sky",
  },
};

/*******************************************************************************
 * Function: saveWorkflowForCanvas
 *
 * Saves workflow for canvas for the workflowCanvas utils module.
 ******************************************************************************/
export function saveWorkflowForCanvas(payload) {
  localStorage.setItem(CANVAS_WORKFLOW_KEY, JSON.stringify(payload));
}

/*******************************************************************************
 * Function: takeWorkflowForCanvas
 *
 * Performs the take Workflow For Canvas operation on workflow for canvas for the workflowCanvas utils module.
 ******************************************************************************/
// ── Chat-edit round-trip helpers ─────────────────────────────────────────────
// saveWorkflowForChatEdit: called from canvas when user clicks "Edit in Chat"
// payload: { yaml, workflowId, workflowName }
export function saveWorkflowForChatEdit(payload) {
  localStorage.setItem(CHAT_EDIT_KEY, JSON.stringify(payload));
}

export function takeWorkflowForChatEdit() {
  const raw = localStorage.getItem(CHAT_EDIT_KEY);
  if (!raw) return null;
  localStorage.removeItem(CHAT_EDIT_KEY);
  try { return JSON.parse(raw); } catch { return null; }
}

export function peekWorkflowForChatEdit() {
  const raw = localStorage.getItem(CHAT_EDIT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function clearWorkflowForChatEdit() {
  localStorage.removeItem(CHAT_EDIT_KEY);
}

export function takeWorkflowForCanvas() {
  const raw = localStorage.getItem(CANVAS_WORKFLOW_KEY);
  if (!raw) return null;
  localStorage.removeItem(CANVAS_WORKFLOW_KEY);

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/*******************************************************************************
 * Function: parseWorkflowYaml
 *
 * Parses workflow yaml for the workflowCanvas utils module.
 ******************************************************************************/
export function parseWorkflowYaml(yaml = "") {
  const lines = yaml.split(/\r?\n/);
  const workflow = { name: "", description: "", steps: [] };
  let inSteps = false;
  let currentStep = null;
  let inParameters = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!inSteps && line.startsWith("name:")) {
      workflow.name = cleanYamlValue(line.slice(5));
      continue;
    }
    if (!inSteps && line.startsWith("description:")) {
      workflow.description = cleanYamlValue(line.slice(12));
      continue;
    }
    if (line === "steps:") {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;

    if (line.startsWith("- id:")) {
      currentStep = {
        id: cleanYamlValue(line.slice(5)),
        action: "",
        description: "",
        parameters: {},
      };
      workflow.steps.push(currentStep);
      inParameters = false;
      continue;
    }
    if (!currentStep) continue;

    if (line.startsWith("action:")) {
      currentStep.action = cleanYamlValue(line.slice(7));
      continue;
    }
    if (line.startsWith("description:")) {
      currentStep.description = cleanYamlValue(line.slice(12));
      continue;
    }
    if (line.startsWith("parameters:")) {
      inParameters = true;
      continue;
    }
    if (line.includes(":") && !line.startsWith("retryCount:") && !line.startsWith("onError:")) {
      const [rawKey, ...rawValue] = line.split(":");
      const key = rawKey.trim();
      const value = cleanYamlValue(rawValue.join(":"));

      if (inParameters) {
        currentStep.parameters[key] = coerceYamlValue(value);
      }
    }
  }

  return workflow;
}

/*******************************************************************************
 * Function: workflowYamlToCanvas
 *
 * Performs the workflow Yaml To Canvas operation on yaml to canvas for the workflowCanvas utils module.
 ******************************************************************************/
export function workflowYamlToCanvas(yaml, metadata = {}) {
  const workflow = parseWorkflowYaml(yaml);
/*******************************************************************************
 * Function: nodes
 *
 * Performs the nodes operation on the application for the workflowCanvas utils module.
 ******************************************************************************/
  const nodes = workflow.steps.map((step, index) => {
    const meta = actionMeta[step.action] ?? {};
    return {
      id: step.id || `step-${index + 1}`,
      type: "erpTool",
      position: { x: 120 + index * 330, y: index % 2 === 0 ? 160 : 330 },
      data: {
        label: meta.label ?? (step.description?.trim() || humanizeAction(step.action)),
        action: step.action,
        description: step.description || humanizeAction(step.action),
        iconKey: meta.iconKey ?? "Database",
        role: meta.role ?? "system",
        status: "idle",
        tone: meta.tone ?? "blue",
        parameters: step.parameters,
      },
    };
  });

/*******************************************************************************
 * Function: edges
 *
 * Performs the edges operation on the application for the workflowCanvas utils module.
 ******************************************************************************/
  const edges = nodes.slice(1).map((node, index) => ({
    id: `edge-${nodes[index].id}-${node.id}`,
    source: nodes[index].id,
    target: node.id,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "#475569", strokeWidth: 2 },
  }));

  return {
    nodes,
    edges,
    workflow: {
      id: metadata.workflowId ?? null,
      name: workflow.name || metadata.name || "Generated workflow",
      description: workflow.description || metadata.description || "",
      yaml,
      candidateId: metadata.candidateId,
      chatSessionId: metadata.chatSessionId,
      chatMessageId: metadata.chatMessageId,
      traceId: metadata.traceId,
    },
  };
}

export function workflowCreationPayload(workflow, yaml) {
  return {
    name: workflow.name,
    description: workflow.description,
    yaml,
    ...(workflow.chatSessionId && workflow.chatMessageId
      ? {
          chatSessionId: workflow.chatSessionId,
          chatMessageId: workflow.chatMessageId,
        }
      : {}),
    ...(workflow.traceId ? { traceId: workflow.traceId } : {}),
  };
}

/*******************************************************************************
 * Function: cleanYamlValue
 *
 * Performs the clean Yaml Value operation on yaml value for the workflowCanvas utils module.
 ******************************************************************************/
function cleanYamlValue(value = "") {
  return value.trim().replace(/^["']|["']$/g, "");
}

/*******************************************************************************
 * Function: coerceYamlValue
 *
 * Performs the coerce Yaml Value operation on yaml value for the workflowCanvas utils module.
 ******************************************************************************/
function coerceYamlValue(value) {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/*******************************************************************************
 * Function: humanizeAction
 *
 * Performs the humanize Action operation on action for the workflowCanvas utils module.
 ******************************************************************************/
function humanizeAction(action = "") {
  return action
    .split(".")
    .pop()
    ?.replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Workflow Step";
}
