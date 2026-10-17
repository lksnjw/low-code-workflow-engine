import { expect, test } from "@jest/globals";
import { workflowChoices, selectedWorkflowChoice } from "./workflowChoices";

test("groups saved requests and proposals by exact identity without altering messages", () => {
  const messages = [{ id: "draft", artifacts: { workflowId: "flow", yaml: "steps: []" } },
    { id: "request", artifacts: { workflowId: "flow", nodeId: "first" } },
    { id: "proposal", artifacts: { proposal: { workflowId: "flow", nodeId: "first" } } }];
  const original = JSON.stringify(messages), choices = workflowChoices(messages);
  expect(choices).toHaveLength(1); expect(choices[0]).toMatchObject({ key: "workflow:flow", aliases: ["draft", "handoff:flow", "request", "proposal"], lastSeen: 2 });
  expect(choices[0].artifact.proposal.nodeId).toBe("first"); expect(JSON.stringify(messages)).toBe(original);
});

test("identical unsaved source is not conflated with saved identity or another draft", () => {
  const choices = workflowChoices([{ id: "one", artifacts: { yaml: "steps: []" } }, { id: "two", artifacts: { yaml: "steps: []" } }, { id: "saved", artifacts: { workflowId: "flow", yaml: "steps: []" } }]);
  expect(choices.map(item => item.key)).toEqual(["message:one", "message:two", "workflow:flow"]);
});

test("old message/handoff selection keys resolve to the same stable saved workflow", () => {
  const choices = workflowChoices([{ id: "old", artifacts: { workflowId: "one" } }, { id: "new", artifacts: { workflowId: "two" } }, { id: "patch", artifacts: { workflowId: "one" } }]);
  for (const key of ["old", "patch", "handoff:one", "workflow:one"]) expect(selectedWorkflowChoice(choices, key)?.artifact.workflowId).toBe("one");
  expect(selectedWorkflowChoice(choices, "new")?.artifact.workflowId).toBe("two");
  expect(selectedWorkflowChoice(choices, "")?.artifact.workflowId).toBe("one");
});

test("unrelated answers do not change choices or selected workflow", () => {
  const messages = [{ id: "one", artifacts: { workflowId: "flow" } }];
  expect(workflowChoices([...messages, { id: "answer", artifacts: { intent: "QUERY" } }])).toEqual(workflowChoices(messages));
  expect(selectedWorkflowChoice([], "stale")).toBeNull();
});

test("server workflow identities survive a latest message page containing no workflow artifacts", () => {
  const catalog = [{ workflowId: "one", name: "Supplier review", lastMessageIndex: 1 }, { workflowId: "two", name: "Invoice review", lastMessageIndex: 5 }];
  const choices = workflowChoices([{ id: "latest", artifacts: { intent: "CAPABILITIES" } }], catalog);
  expect(choices.map(choice => choice.key)).toEqual(["workflow:one", "workflow:two"]);
  expect(selectedWorkflowChoice(choices, "workflow:one").artifact.workflowId).toBe("one");
  expect(selectedWorkflowChoice(choices, "").artifact.workflowId).toBe("two");
  expect(choices.every(choice => choice.artifact.yaml === undefined)).toBe(true);
});

test("older loaded messages merge with the catalog without duplicates or overriding the latest proposal", () => {
  const catalog = [{ workflowId: "flow", name: "Saved review", lastMessageIndex: 2 }];
  const choices = workflowChoices([{ id: "draft", artifacts: { workflowId: "flow", yaml: "steps: []" } }, { id: "patch", artifacts: { proposal: { workflowId: "flow", nodeId: "read" } } }], catalog);
  expect(choices).toHaveLength(1); expect(choices[0].artifact.proposal.nodeId).toBe("read");
  expect(choices[0].aliases).toContain("draft");
});
