import { describe, expect, test } from "vitest";
import { createExperimentSpyTool, requireExperimentSafeTools } from "../packages/experiment/src/safe-tools.js";

describe("experiment artifact tool safety", () => {
  test("accepts only closure-registered spy tools", () => {
    const safe = createExperimentSpyTool("experiment.spy", () => undefined);
    expect(() => requireExperimentSafeTools([safe])).not.toThrow();
    const forged = Object.freeze({ name: "real.dispatch", async execute() { return { dispatched: true }; } });
    expect(() => requireExperimentSafeTools([forged])).toThrow("refuses non-spy tool");
  });
});
