import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parse } from "yaml";
import { pipelineOrigin } from "./pipeline-bridge-tools.mjs";

/** Registers contracts only. Per-role low-code review and caller delegation
 * are still required; no documents or ERP records are changed. */
export async function applyDocumentWorkspaceTools({ bridgeURL, pipelineURL, token }) {
  const bridge = pipelineOrigin(bridgeURL), origin = pipelineOrigin(pipelineURL);
  if (!token?.trim()) throw new Error("ERPBridge administration token is required");
  const directory = new URL("../../ops/erpbridge/manifests/document-workspace/", import.meta.url), applied = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".yaml")).sort()) {
    const tool = parse(await readFile(new URL(file, directory), "utf8"));
    tool.spec.execution.endpoint = `${origin}${tool.spec.execution.endpoint}`;
    tool.spec.execution.approvedOrigins = [origin];
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response = await fetch(`${bridge}/apis/erpbridge.io/v1/tools`, { method: "POST", headers, body: JSON.stringify(tool), signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) throw new Error(`Private document tool registration failed: ${tool.metadata.name}, HTTP ${response.status}`);
    await response.body?.cancel();
    const readback = await fetch(`${bridge}/apis/erpbridge.io/v1/tools?${new URLSearchParams({ name: tool.metadata.name, version: tool.metadata.version })}`, { headers, signal: AbortSignal.timeout(15000) });
    const saved = await readback.json();
    if (!readback.ok || !Array.isArray(saved) || saved.length !== 1 || saved[0].spec.execution.endpoint !== tool.spec.execution.endpoint || !saved[0].metadata.resourceDigest)
      throw new Error("Private document manifest readback did not confirm the exact binding");
    applied.push(saved[0]);
  }
  return applied;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--apply") throw new Error("Use --apply with ERPBRIDGE_BASE_URL, PIPELINE_RETRIEVAL_BASE_URL and BRIDGE_API_TOKEN");
  const result = await applyDocumentWorkspaceTools({ bridgeURL: process.env.ERPBRIDGE_BASE_URL, pipelineURL: process.env.PIPELINE_RETRIEVAL_BASE_URL, token: process.env.BRIDGE_API_TOKEN });
  console.log(`Registered and read back ${result.length} private document tools. Current capability review and signed caller delegation remain mandatory.`);
}
