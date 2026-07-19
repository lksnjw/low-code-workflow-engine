import { describe, expect, test } from "@jest/globals";
import { normalizeWorkflow } from "../../../services/workflow.service";

describe("workflow API normalization", () => {
  test("normalizes an API workflow without adding sample records", () => {
    const workflow = normalizeWorkflow({ id: "wf_1", name: "Actual", owner: { name: "Owner" }, trigger: { type: "manual" }, successRate: 0 });
    expect(workflow.id).toBe("wf_1");
    expect(workflow.owner).toBe("Owner");
    expect(workflow.lastRun).toBe("Never");
  });
});
