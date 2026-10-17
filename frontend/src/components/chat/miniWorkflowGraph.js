const W = 184, H = 96, DX = 248, DY = 148;

// Display geometry only. Saved scopes define every connection; the canvas
// never compiles dragged positions or execution receipts into workflow logic.
export function miniWorkflowGraph(steps, flow, declaredStructure = false, approvalNodes = []) {
  if (!flow && declaredStructure) return { error: "Reload the workflow to view its decision paths.", nodes: [], edges: [] };
  const definitions = new Map(steps.map((step, index) => [step.id, { step, index }]));
  const nodes = [], edges = [], seen = new Set();
  const approvals = new Set(approvalNodes);
  const edge = (from, to, label = "", branch = null) => edges.push({ from, to, label, branch });
  const add = (id, kind, x, y, control) => {
    if (typeof id !== "string" || seen.has(id) || seen.size >= 600 || kind !== "action" && definitions.has(id)) throw new Error("Workflow structure could not be displayed.");
    seen.add(id);
    const definition = definitions.get(id), step = definition?.step;
    const title = kind === "approval" ? `Human approval · ${definitions.get(control.nodeId)?.step?.source.description || control.nodeId}` : step?.source.description || step?.label || id.replaceAll("_", " ").replaceAll("-", " ").replace(/^./, character => character.toUpperCase());
    nodes.push({ id, kind, x, y, title, step, index: definition?.index, control });
  };
  const sequence = (block, x, y, depth = 0) => {
    if (depth > 8 || block?.kind !== "sequence" || !Array.isArray(block.nodes)) throw new Error("Workflow structure could not be displayed.");
    let first = null, exits = [], right = x, bottom = y + H;
    for (const control of block.nodes) {
      const kind = control.kind, id = kind === "action" ? control.nodeId : control.id;
      if (!["action", "if", "foreach", "protect", "return"].includes(kind) || kind === "action" && !definitions.has(id)) throw new Error("Workflow structure could not be displayed.");
      const entry = kind === "action" && approvals.has(id) ? `approval:${id}` : id;
      if (entry !== id) { add(entry, "approval", right, y, { nodeId: id }); right += DX; edge(entry, id, "If approved"); }
      add(id, kind, right, y, control);
      if (!first) first = entry;
      for (const exit of exits) edge(exit.id, entry, exit.label, exit.branch);
      let next = right + DX;
      if (kind === "if" || kind === "protect") {
        const branches = kind === "if" ? [["then", "Yes"], ["else", "No"]] : [["body", "Try"], ["handler", "Missing record"]];
        let branchY = y, branchRight = next;
        exits = [];
        for (const [name, label] of branches) {
          const child = sequence(control[name], next, branchY, depth + 1), branch = { nodeId: id, path: name };
          if (child.first) { edge(id, child.first, label, branch); exits.push(...child.exits); }
          else exits.push({ id, label, branch });
          branchRight = Math.max(branchRight, child.right);
          branchY = child.bottom + (DY - H);
          bottom = Math.max(bottom, child.bottom);
        }
        next = branchRight + DX;
      } else if (kind === "foreach") {
        const child = sequence(control.body, next, y, depth + 1);
        if (child.first) edge(id, child.first, "Each item");
        // The loop owns completion. Its body's final step is not an exit to
        // the next root action, and individual item outcomes are not inferred.
        for (const exit of child.exits) edge(exit.id, id, "Next item", { nodeId: id, path: "repeat" });
        exits = [{ id, label: "When complete" }];
        next = Math.max(next, child.right + DX);
        bottom = Math.max(bottom, child.bottom);
      } else exits = kind === "return" ? [] : [{ id }];
      right = next;
    }
    return { first, exits, right: Math.max(x, right - DX), bottom };
  };
  try {
    if (flow) sequence(flow, 28, 48);
    else steps.flatMap(step => approvals.has(step.id) ? [{ id: `approval:${step.id}`, kind: "approval", control: { nodeId: step.id } }, { id: step.id, kind: "action" }] : [{ id: step.id, kind: "action" }]).forEach((item, index, display) => {
      // Snake rows keep a 100+ step sequence navigable without shrinking text.
      const row = Math.floor(index / 3), column = row % 2 ? 2 - index % 3 : index % 3;
      add(item.id, item.kind, 28 + column * DX, 48 + row * DY, item.control);
      if (index) edge(display[index - 1].id, item.id, display[index - 1].kind === "approval" ? "If approved" : "");
    });
    if (steps.some(step => !seen.has(step.id))) throw new Error("Workflow steps do not match the saved structure.");
    return { nodes, edges, width: Math.max(600, ...nodes.map(node => node.x + W + 28)), height: Math.max(280, ...nodes.map(node => node.y + H + 48)), nodeWidth: W, nodeHeight: H, error: "" };
  } catch (error) { return { error: error.message, nodes: [], edges: [] }; }
}

export function miniNodeEvidence(id, run, timeline = [], decisions = {}, values = {}) {
  const attempt = timeline.findLast(entry => entry.nodeId === id);
  const output = run?.stepOutputs?.[id];
  const decision = decisions[id];
  if (decision?.status === "DONE" && ["then", "else"].includes(decision.selected)) return { label: decision.selected === "then" ? "Yes path selected" : "No path selected", tone: "done" };
  if (attempt?.status === "FAILED") return { label: "Stopped", tone: "failed" };
  if (attempt?.status === "AWAITING_APPROVAL" && run && run.status !== "AWAITING_APPROVAL") return { label: "Review recorded · Check run", tone: "attention" };
  if (values[id]?.status === "DONE") return { label: "Result ready", tone: "done" };
  if (output !== undefined) {
    const rows = output?.structuredContent?.data;
    return { label: Array.isArray(rows) ? `${rows.length} records · View answer` : "Answer ready", tone: "done" };
  }
  return ({ RUNNING: { label: "Working…", tone: "running" }, AWAITING_APPROVAL: { label: "Needs approval", tone: "attention" }, UNKNOWN: { label: "Check outcome", tone: "attention" }, SKIPPED: { label: "Skipped", tone: "idle" }, DONE: { label: "Completed", tone: "done" } })[attempt?.status] || { label: "Ready", tone: "idle" };
}

export function unselectedMiniNodes(flow, decisions = {}) {
  const skipped = new Set();
  const walk = (sequence, excluded = false, depth = 0) => {
    if (depth > 8 || !Array.isArray(sequence?.nodes)) return;
    for (const node of sequence.nodes) {
      if (excluded) skipped.add(node.kind === "action" ? node.nodeId : node.id);
      const decision = decisions[node.id], selected = decision?.status === "DONE" && ["then", "else"].includes(decision.selected) ? decision.selected : null;
      if (node.kind === "if") for (const branch of ["then", "else"]) walk(node[branch], excluded || Boolean(selected && selected !== branch), depth + 1);
      else if (node.kind === "foreach") walk(node.body, excluded, depth + 1);
      else if (node.kind === "protect") { walk(node.body, excluded, depth + 1); walk(node.handler, excluded, depth + 1); }
    }
  };
  walk(flow);
  return skipped;
}
