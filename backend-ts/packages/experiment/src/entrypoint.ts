import Fastify from "fastify";
import { createExperimentSpyTool, requireExperimentSafeTools } from "./safe-tools.js";

const calls: Record<string, unknown>[] = [];
const tools = [createExperimentSpyTool("experiment.spy", (parameters) => calls.push(parameters))];
requireExperimentSafeTools(tools);
const app = Fastify({ logger: true });
app.get("/healthz", async () => ({ success: true, data: { service: "backend-ts-experiment", safeTools: tools.length, calls: calls.length }, message: "OK", meta: null }));
await app.listen({ host: "127.0.0.1", port: 8082 });
