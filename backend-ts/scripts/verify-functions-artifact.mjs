import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../.functions");
const expected = new Set(["index.mjs", "artifact.json", "package.json", "package-lock.json", "assets/configs/runtime/all_tools_master_registry.json",
  "assets/configs/runtime/all_rules_master_registry.json", "assets/configs/runtime/registry_context.md", "assets/policy/governance_fallback.json"]);
async function walk(path, prefix = "") {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const scoped = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("Functions artifact cannot contain symlinks");
    if (entry.isDirectory()) {
      assert(["assets", "assets/configs", "assets/configs/runtime", "assets/policy"].includes(scoped), "Unexpected artifact directory");
      await walk(resolve(path, entry.name), `${scoped}/`);
    } else { assert(expected.delete(scoped), `Unexpected or duplicate Functions artifact file: ${scoped}`); }
  }
}
await walk(directory); assert.equal(expected.size, 0, "Functions artifact files are missing");
const manifest = JSON.parse(await readFile(resolve(directory, "artifact.json"), "utf8"));
assert.equal(manifest.profile, "lcwe-functions-artifact/v1"); assert.equal(manifest.qualification, "READ_CHAT_READBACK_OPERATION_LIFECYCLE_ADAPTER_ONLY");
assert.deepEqual(Object.keys(manifest.assets).sort(), ["configs/runtime/all_rules_master_registry.json", "configs/runtime/all_tools_master_registry.json", "configs/runtime/registry_context.md", "policy/governance_fallback.json"]);
for (const [path, digest] of Object.entries(manifest.assets))
  assert.equal(createHash("sha256").update(await readFile(resolve(directory, "assets", path))).digest("hex"), digest, "Packaged asset hash changed");
const pkg = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
assert.equal(pkg.main, "index.mjs"); assert.equal(pkg.engines.node, "22"); assert.deepEqual(pkg.scripts, {});
assert.equal(pkg.dependencies["firebase-admin"], "14.5.0"); assert.equal(pkg.dependencies["firebase-functions"], "7.4.0");
assert.equal(pkg.dependencies["@earendil-works/pi-agent-core"], "1.2.0"); assert.equal(pkg.dependencies["@earendil-works/pi-ai"], "1.2.0");
// Discovery must be side-effect free even without runtime configuration.
const handlers = await import(pathToFileURL(resolve(directory, "index.mjs")).href);
assert.deepEqual(Object.keys(handlers).sort(), ["advanceWorkflowLifecycle", "api", "executeChatTask", "executeOperationTask", "executeReadTask", "executeReadbackTask", "recoverReadTaskDispatch"]);
assert.deepEqual(handlers.api.__endpoint.httpsTrigger.invoker, ["public"]);
assert.equal(handlers.api.__endpoint.minInstances, 1);
for (const name of ["api", "executeChatTask", "executeReadTask", "executeReadbackTask", "executeOperationTask"]) {
  assert.equal(handlers[name].__endpoint.availableMemoryMb, 4096);
  assert.equal(handlers[name].__endpoint.cpu, 2);
  assert.equal(handlers[name].__endpoint.timeoutSeconds, 300);
  assert.equal(handlers[name].__endpoint.maxInstances, name==="api"?4:2);
}
for (const name of ["recoverReadTaskDispatch", "advanceWorkflowLifecycle"]) {
  assert.equal(handlers[name].__endpoint.availableMemoryMb, 1024);
  assert.equal(handlers[name].__endpoint.cpu, 2);
}
assert.deepEqual(handlers.executeReadTask.__endpoint.taskQueueTrigger.invoker, ["private"]);
assert.equal(handlers.executeReadTask.__endpoint.taskQueueTrigger.rateLimits.maxConcurrentDispatches, 1);
assert.deepEqual(handlers.executeChatTask.__endpoint.taskQueueTrigger.invoker, ["private"]);
assert.equal(handlers.executeChatTask.__endpoint.taskQueueTrigger.rateLimits.maxConcurrentDispatches, 1);
assert.deepEqual(handlers.executeReadbackTask.__endpoint.taskQueueTrigger.invoker, ["private"]);
assert.equal(handlers.executeReadbackTask.__endpoint.taskQueueTrigger.rateLimits.maxConcurrentDispatches, 1);
assert.deepEqual(handlers.executeOperationTask.__endpoint.taskQueueTrigger.invoker, ["private"]);
assert.equal(handlers.executeOperationTask.__endpoint.taskQueueTrigger.rateLimits.maxConcurrentDispatches, 1);
assert.equal(handlers.recoverReadTaskDispatch.__endpoint.scheduleTrigger.schedule, "every 1 minutes");
assert.equal(handlers.advanceWorkflowLifecycle.__endpoint.scheduleTrigger.schedule, "every 1 minutes");
assert.equal(handlers.advanceWorkflowLifecycle.__endpoint.scheduleTrigger.timeZone, "Asia/Colombo");
assert.equal(handlers.advanceWorkflowLifecycle.__endpoint.scheduleTrigger.retryConfig.retryCount, 3);
console.log("PASS: seven actual Firebase exports, private read/chat/readback/operation task metadata, bounded lifecycle schedule, exact packaged assets and curated upload files; partial adaptation only");
if (process.argv.includes("--deploy") && process.env.LCWE_ALLOW_PARTIAL_FUNCTIONS_DEPLOY !== "read-chat-readback-operation-lifecycle-preview")
  throw new Error("Full Functions readiness is incomplete. A partial lifecycle preview requires an explicitly authorized deployment and LCWE_ALLOW_PARTIAL_FUNCTIONS_DEPLOY=read-chat-readback-operation-lifecycle-preview; this does not qualify the complete application or deployed scheduling.");
