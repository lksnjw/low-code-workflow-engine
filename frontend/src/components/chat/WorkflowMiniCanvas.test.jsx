/** @jest-environment jsdom */
import React from "react";
import { test, expect, jest, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkflowMiniCanvas from "./WorkflowMiniCanvas";
import WorkflowSourcePreview from "./WorkflowSourcePreview";
import { miniWorkflowGraph, miniNodeEvidence, unselectedMiniNodes } from "./miniWorkflowGraph";

afterEach(cleanup);
const steps = ["read", "yes", "no", "send"].map(id => ({ id, label: id, source: { id, action: `demo.${id}`, description: `Step ${id}` } }));
const action = nodeId => ({ kind: "action", nodeId });
const sequence = (...nodes) => ({ kind: "sequence", nodes });

test("reset view restores zoom and scroll without editing nodes or invoking tools", () => {
  const select = jest.fn(), before = JSON.stringify(steps);
  const { rerender } = render(<WorkflowMiniCanvas simple steps={steps} onSelectCondition={select} viewReset={0} />);
  screen.getByLabelText("Workflow node connections").scrollLeft = 200;
  fireEvent.click(screen.getByRole("button", { name: "Zoom in canvas" }));
  expect(screen.getByRole("button", { name: "Reset canvas zoom" }).textContent).toBe("125%");
  rerender(<WorkflowMiniCanvas simple steps={steps} onSelectCondition={select} viewReset={1} />);
  expect(screen.getByRole("button", { name: "Reset canvas zoom" }).textContent).toBe("100%");
  expect(screen.getByLabelText("Workflow node connections").scrollLeft).toBe(0);
  expect(select).not.toHaveBeenCalled(); expect(JSON.stringify(steps)).toBe(before);
});

test("first canvas input entry opens preparation without selecting or executing an ERP step", () => {
  const prepare = jest.fn(), select = jest.fn();
  render(<WorkflowMiniCanvas simple steps={steps} onPrepareInputs={prepare} onSelectCondition={select} />);
  fireEvent.click(screen.getByRole("button", { name: "Select input Inputs & documents" }));
  expect(prepare).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: /^Select step/ })).toHaveLength(4);
  expect(screen.getByText("Upload image/PDF or enter fields")).toBeTruthy();
});

test("required human approval is an explicit display gate before the effect, without changing saved branches", () => {
  const flow = sequence(action("read"), { id: "check", kind: "if", then: sequence(action("send")), else: sequence({ id: "finish", kind: "return" }) });
  const before = JSON.stringify(flow);
  const graph = miniWorkflowGraph([steps[0], steps[3]], flow, true, ["send"]);
  expect(graph.error).toBe(""); expect(JSON.stringify(flow)).toBe(before);
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: "check", to: "approval:send", label: "Yes" }),
    expect.objectContaining({ from: "approval:send", to: "send", label: "If approved" }),
  ]));
  expect(graph.nodes.filter(node => node.kind === "approval")).toHaveLength(1);
  expect(graph.edges.some(edge => edge.from === "finish")).toBe(false);
});

test("the paused human approval node opens its exact review, never dispatches an action", () => {
  const review = jest.fn(), select = jest.fn();
  render(<WorkflowMiniCanvas simple steps={steps} approvalNodes={["send"]} timeline={[{ nodeId: "send", status: "AWAITING_APPROVAL" }]} onSelectCondition={select} onReviewApproval={review} />);
  expect(screen.getByText("Paused · Review here")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select approval Human approval · Step send" }));
  expect(select).not.toHaveBeenCalled(); expect(review).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("button", { name: /^Select step/ })).toHaveLength(4);
});

test("a future human gate is not misrepresented as an active approval or a completed step", () => {
  const review = jest.fn();
  render(<WorkflowMiniCanvas simple steps={steps} approvalNodes={["send"]} onSelectCondition={jest.fn()} onReviewApproval={review} />);
  expect(screen.getByText("Required before this action")).toBeTruthy(); expect(screen.queryByText("Paused · Review here")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select approval Human approval · Step send" }));
  expect(screen.getByRole("complementary", { name: "Human approval checkpoint details" }).textContent).toContain("not a workflow-edit approval");
  expect(review).not.toHaveBeenCalled();
});

test("tree preview retains human checkpoints and a recorded old wait does not become a new pending review", () => {
  const review = jest.fn();
  render(<WorkflowMiniCanvas simple steps={steps} approvalNodes={["send"]} run={{ status: "BLOCKED" }} timeline={[{ nodeId: "send", status: "AWAITING_APPROVAL" }]} onSelectCondition={jest.fn()} onReviewApproval={review} renderAction={step => <li>{step.label}</li>} />);
  expect(screen.queryByText("Paused · Review here")).toBeNull();
  expect(screen.getAllByText("Review recorded · Check run")).toHaveLength(2);
  fireEvent.click(screen.getByRole("tab", { name: "Workflow preview" }));
  expect(screen.getByRole("listitem", { name: "Human approval before send" }).textContent).toContain("Human approval");
  expect(screen.queryByRole("button", { name: "Review exact transaction here" })).toBeNull();
  expect(review).not.toHaveBeenCalled();
});

test("an empty saved draft explains its unresolved requirements instead of drawing a blank grid", () => {
  const controls = jest.fn(), chat = jest.fn();
  render(<WorkflowMiniCanvas simple savedDraft steps={[]} onSelectCondition={jest.fn()} emptyDescription="ERP report tools are not available yet." unresolvedRequirements={["Choose a reporting tool", "Confirm delivery timezone"]} onOpenControls={controls} onContinueChat={chat} />);
  expect(screen.getByRole("status", { name: "Empty saved workflow" }).textContent).toContain("no steps yet");
  expect(screen.getByText("Choose a reporting tool")).toBeTruthy(); expect(screen.queryByLabelText("Workflow node connections")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review requirements and add steps" })); expect(controls).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Complete in chat" })); expect(chat).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/not a pending approval/)).toBeTruthy(); expect(screen.queryByRole("button", { name: /^(OK|Approve)$/ })).toBeNull();
});

test("decision arrows retain both declared paths and their shared continuation", () => {
  const graph = miniWorkflowGraph(steps, sequence(action("read"), { id: "check", kind: "if", then: sequence(action("yes")), else: sequence(action("no")) }, action("send")), true);
  expect(graph.error).toBe("");
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: "read", to: "check" }),
    expect.objectContaining({ from: "check", to: "yes", label: "Yes" }),
    expect.objectContaining({ from: "check", to: "no", label: "No" }),
    expect.objectContaining({ from: "yes", to: "send" }),
    expect.objectContaining({ from: "no", to: "send" }),
  ]));
});

test("Yes and No labels occupy different positions on diverging decision arrows", () => {
  render(<WorkflowMiniCanvas simple steps={steps} declaredStructure flow={sequence(action("read"), { id: "check", kind: "if", then: sequence(action("yes")), else: sequence(action("no")) }, action("send"))} onSelectCondition={() => {}} />);
  const yes = screen.getByText("Yes", { selector: "text" }), no = screen.getByText("No", { selector: "text" });
  expect([yes.getAttribute("x"), yes.getAttribute("y")]).not.toEqual([no.getAttribute("x"), no.getAttribute("y")]);
});

test("a returning branch has no edge to a later effect and unavailable structure is not flattened", () => {
  const graph = miniWorkflowGraph([steps[0], steps[3]], sequence({ id: "check", kind: "if", then: sequence(action("read")), else: sequence({ id: "finish", kind: "return" }) }, action("send")), true);
  expect(graph.edges.some(edge => edge.from === "finish")).toBe(false);
  const flow = sequence({ id: "check", kind: "if", then: sequence(action("read")), else: sequence({ id: "finish", kind: "return" }) });
  expect([...unselectedMiniNodes(flow, { check: { status: "DONE", selected: "then" } })]).toEqual(["finish"]);
  expect(unselectedMiniNodes(flow, { check: { status: "FAILED", selected: "then" } }).size).toBe(0);
  expect(miniWorkflowGraph(steps, undefined, true).edges).toEqual([]);
  expect(miniWorkflowGraph(steps, sequence(action("read")), true).error).toBeTruthy();
});

test("101 nodes stay readable and selection renders only one answer", () => {
  const many = Array.from({ length: 101 }, (_, index) => ({ id: `step_${index}`, label: `ERP read ${index + 1}`, source: {} }));
  const onSelect = jest.fn(), answer = jest.fn(step => <li>Answer for {step.label}</li>);
  const props = { simple: true, steps: many, selectedId: "step_100", onSelectCondition: onSelect, renderAction: answer };
  const graph = miniWorkflowGraph(many);
  expect(graph.nodes).toHaveLength(101); expect(graph.edges).toHaveLength(100); expect(graph.width).toBeLessThan(900);
  render(<WorkflowMiniCanvas {...props} />);
  expect(screen.getAllByRole("button", { name: /^Select step/ })).toHaveLength(101);
  expect(screen.getByText("Answer for ERP read 101")).toBeTruthy(); expect(answer).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Find workflow step" }), { target: { value: "ERP read 51" } });
  fireEvent.click(screen.getByRole("button", { name: "ERP read 51", exact: true }));
  expect(onSelect).toHaveBeenLastCalledWith("step_50");
});

test("saved answers outrank a stale running event while failures and exact decisions remain explicit", () => {
  expect(miniNodeEvidence("read", { stepOutputs: { read: { structuredContent: { data: [1, 2] } } } }, [{ nodeId: "read", status: "RUNNING" }]).label).toBe("2 records · View answer");
  expect(miniNodeEvidence("read", undefined, [{ nodeId: "read", status: "AWAITING_APPROVAL" }]).label).toBe("Needs approval");
  expect(miniNodeEvidence("check", undefined, [], { check: { status: "DONE", selected: "else" } }).label).toBe("No path selected");
});

test("supervisor JSON and YAML previews retain the saved workflow fields", () => {
  const source = "name: Demo\nsteps:\n - id: read\n   action: demo.read\n   parameters: {limit: 8}\n";
  render(<WorkflowSourcePreview source={source} />);
  fireEvent.click(screen.getByText("JSON preview & workflow source"));
  expect(JSON.parse(screen.getByLabelText("Workflow JSON").textContent).steps[0].parameters).toEqual({ limit: 8 });
  fireEvent.click(screen.getByRole("button", { name: "Workflow source (YAML)" }));
  expect(screen.getByLabelText("Workflow YAML").textContent).toBe(source);
});
