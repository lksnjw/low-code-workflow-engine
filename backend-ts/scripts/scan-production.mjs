import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const artifacts = ["server.mjs", "server.mjs.map", "meta.json"].map((name) => resolve("dist/production", name));
const forbidden = [
  "setBaselineB",
  "baselineBEnabled",
  "auditBaselineBypass",
  "ExperimentSafeTool",
  "LCWE_EXPERIMENT_GATE_OFF",
  "packages/experiment",
];
const findings = [];
for (const artifact of artifacts) {
  const source = await readFile(artifact, "utf8");
  for (const value of forbidden) if (source.includes(value)) findings.push({ artifact, value });
}
const result = { artifacts, forbidden, findings, passed: findings.length === 0 };
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
