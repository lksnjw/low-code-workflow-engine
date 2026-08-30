import { canonicalJSONBytes } from "../core/canonical-json.js";
import type {
  DispatchCapability,
  RegistryValidator,
} from "../validator/registry-validator.js";
import type { DispatchIdentity } from "./registry.js";

export type MCPMode = "remote" | "mock";

export class MCPHTTPError extends Error {
  constructor(readonly statusCode: number) {
    super(`MCP bridge returned HTTP ${statusCode}`);
    this.name = "MCPHTTPError";
  }
}

export type GovernedMCPClient = Readonly<{
  execute(
    action: string,
    capability: DispatchCapability,
    parameters: Record<string, unknown>,
    identity: DispatchIdentity,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}>;

export function createGovernedMCPClient(options: {
  baseURL: string;
  timeoutMs: number;
  mode: MCPMode;
  validator: RegistryValidator;
  fetchImplementation?: typeof fetch;
}): GovernedMCPClient {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  // This is intentionally closure-private. No module export can send MCP HTTP.
  async function performHTTPRequest(
    action: string,
    parameterBytes: Buffer,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (options.baseURL.trim() === "")
      throw new Error("MCP_BASE_URL is required in remote mode");
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const combinedSignal =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal]);
    const body = Buffer.concat([
      Buffer.from(`{"action":${JSON.stringify(action)},"parameters":`),
      parameterBytes,
      Buffer.from("}"),
    ]);
    const response = await fetchImplementation(
      `${options.baseURL}/tools/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: combinedSignal,
      },
    );
    if (response.status >= 400) throw new MCPHTTPError(response.status);
    const decoded: unknown = await response.json();
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    )
      throw new Error("decode MCP response: expected a JSON object");
    return decoded as Record<string, unknown>;
  }

  return Object.freeze({
    async execute(
      action: string,
      capability: DispatchCapability,
      parameters: Record<string, unknown>,
      identity: DispatchIdentity,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      const parameterBytes = canonicalJSONBytes(parameters);
      options.validator.verifyAndConsumeCapability(
        capability,
        action,
        parameterBytes,
        identity,
      );
      if (options.mode === "mock") {
        if (action === "demo.echo")
          return { action: "demo.echo", mock: true, echo: { ...parameters } };
        if (action === "fetch_attendance")
          return mockFetchAttendance(parameters);
        throw new Error(
          `mock MCP action ${JSON.stringify(action)} is not supported`,
        );
      }
      return performHTTPRequest(action, parameterBytes, signal);
    },
  });
}

function mockFetchAttendance(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const requested = firstString(
    parameters.employee_id,
    parameters.employeeId,
    parameters.id,
  );
  const employeeIDs = Array.from(
    { length: 25 },
    (_unused, index) => `EMP-${String(index + 1).padStart(3, "0")}`,
  );
  let selected = employeeIDs.slice(0, 5);
  if (requested !== "") {
    const employeeID = employeeIDs.find(
      (item) => item.toLowerCase() === requested.toLowerCase(),
    );
    if (employeeID === undefined)
      throw new Error("mock ERP employee not found");
    selected = [employeeID];
  }
  const attendance = selected.map((employeeId, index) => ({
    employeeId,
    date: "2026-07-15",
    hours: index % 3 === 2 ? 7.5 : 8,
    status: "present",
  }));
  return { attendance, count: attendance.length };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text !== "" && text !== "<nil>") return text;
  }
  return "";
}
