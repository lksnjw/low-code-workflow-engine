import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const port = await reservePort();
const artifact = resolve("dist/production/server.mjs");
const child = spawn(process.execPath, [artifact], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    APP_ENV: "test",
    PORT: String(port),
    JWT_SECRET: "production-inert-test-secret",
    PLATFORM_ADMIN_PASSWORD: "production-inert-test-password",
    STORAGE_DRIVER: "memory",
    MCP_MODE: "mock",
    TOOL_REGISTRY_PATH: resolve("fixtures/parity/http/runtime/all_tools_master_registry.json"),
    RULE_REGISTRY_PATH: resolve("fixtures/parity/http/runtime/all_rules_master_registry.json"),
    LCWE_EXPERIMENT_GATE_OFF: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  const response = await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  const payload = await response.json();
  if (response.status !== 200 || payload?.success !== true || payload?.data?.service !== "low-code-workflow-engine-ts") {
    throw new Error(`unexpected production health response: ${response.status} ${JSON.stringify(payload)}`);
  }
  console.log(JSON.stringify({ artifact, experimentEnvironmentSet: true, status: response.status, service: payload.data.service, passed: true }, null, 2));
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000))]);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not reserve a TCP port");
  await new Promise((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
  return address.port;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production artifact exited early (${child.exitCode})\n${output}`);
    try { return await fetch(url); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  }
  throw new Error(`production artifact did not become healthy\n${output}`);
}
