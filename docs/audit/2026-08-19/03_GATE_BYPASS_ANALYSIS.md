# Gate bypass analysis

## Execution and state-changing paths

| Entry point | Reaches tool execution? | Gate | Full or lightweight | Evidence |
|---|---:|---|---|---|
| `POST /api/workflows/:id/run` | Yes | Normal mode: plan gate, token gate, per-step dispatch check | Full at plan; signed-token check plus deferred-rule/sensitive scan at dispatch | `backend/internal/api/routes/routes.go:85`, `backend/internal/api/handlers/execute_handler.go:22-83`, `backend/internal/core/runner/executor.go:62-171` |
| `POST /api/executions/:id/retry` | Yes | Delegates to the same run handler | Same, but no idempotency | `backend/internal/api/routes/routes.go:136`, `backend/internal/api/handlers/execute_handler.go:457-469` |
| `Executor.Run` exported internal API | Yes | Requires a signed token unless `baselineB` | Token/hash check plus lightweight dispatch | `backend/internal/core/runner/executor.go:45-75`, `backend/internal/core/runner/executor.go:135-171`, `backend/internal/core/runner/executor.go:200-217` |
| `Tool.Execute` interface / concrete MCP tools | Yes | None inside tool; trusts caller | None | `backend/internal/tools/tool_interface.go:5-9`, `backend/internal/tools/mcp_client.go:121-143` |
| WebSocket `/ws/*` | No | N/A | Authenticated health snapshot only | `backend/internal/api/routes/routes.go:14`, `backend/internal/api/handlers/websocket_handler.go:12-48` |
| Chat message | No direct execution | Every generated candidate is validated before `CanExecute=true` | Full candidate gate | `backend/internal/api/routes/routes.go:128`, `backend/internal/core/orchestrator/chat_orchestrator.go:116-200` |
| Workflow create/update/YAML/publish/restore/template/import | Persists executable definitions, not a tool call | Full gate before persistence | Full | `backend/internal/api/handlers/workflow_handler.go:76-96`, `backend/internal/api/handlers/workflow_handler.go:139-160`, `backend/internal/api/handlers/workflow_handler.go:218-243`, `backend/internal/api/handlers/workflow_handler.go:297-318`, `backend/internal/api/handlers/workflow_handler.go:443-470`, `backend/internal/api/handlers/workflow_handler.go:520-539`, `backend/internal/api/handlers/notification_handler.go:117-145` |
| Canvas save | Persists state that could affect execution | Semantic changes mark workflow `DRAFT_UNVALIDATED`; run rejects that status | No executable conversion at save; later full run gate | `backend/internal/api/handlers/gate_invariant_test.go:158-178`, `backend/internal/api/handlers/execute_handler.go:39-46` |
| Healing | Does not automatically execute repaired YAML | Full validation before storing repair availability | Full | `backend/internal/api/handlers/execute_handler.go:106-134` |
| Experiment runner and server Baseline B | Yes (spy in harness; real registry in configured server) | Gate decisions audited but deliberately ignored | Gate off | `backend/dataset/eval/experiment.go:202-243`, `backend/cmd/server/main.go:170-173`, `backend/internal/api/handlers/gate_invariant_test.go:215-237` |

All other HTTP mutations change local application state, registry state, settings, users, or integrations but do not invoke the workflow tool runner; the complete route registration is `backend/internal/api/routes/routes.go:13-214`. Several integration/webhook test handlers do make outbound probes outside the workflow runner, which are administrative effects not mediated by the workflow gate (`backend/internal/api/routes/routes.go:184-204`, `backend/internal/api/handlers/settings_handler.go:300-416`).

## Exported execution-capable functions

- `(*runner.Executor).Run` can reach `Tool.Execute`. A signed token blocks ordinary internal callers, but the exported `SetBaselineB(true)` disables that block and has no caller-identity or build-tag guard (`backend/internal/core/runner/executor.go:52-72`, `backend/internal/core/runner/executor.go:171-184`).
- Every implementation of the exported `tools.Tool.Execute` interface can be called directly by any importing internal package; validation is architectural convention, not enforced by the interface (`backend/internal/tools/tool_interface.go:5-9`, `backend/internal/tools/mcp_client.go:137-143`).
- `(*tools.MCPClient).Execute` sends directly to `/tools/execute` with no validation token or registry proof, so an internal caller can bypass the gate (`backend/internal/tools/mcp_client.go:60-101`).
- `(*handlers.Handler).RunWorkflow` and `RetryExecution` are router-reachable wrappers around the protected normal path (`backend/internal/api/handlers/execute_handler.go:22-83`, `backend/internal/api/handlers/execute_handler.go:457-469`).

## Guards, flags, and strictness

The nil-validator condition is rejected in both handler and runner constructors (`backend/internal/api/handlers/handler.go:48-51`, `backend/internal/core/runner/executor.go:45-49`). The bypass search found no build tag and one feature/config exception: `EXPERIMENT_BASELINE=B`, restricted only by the string value `APP_ENV=experiment` (`backend/internal/config/config.go:196-203`, `backend/internal/config/config.go:258-260`). This restriction does not prevent the ordinary HTTP server from starting and registering real MCP tools (`backend/cmd/server/main.go:138-173`).

Strict workflow YAML parsing uses `KnownFields(true)`, so unknown YAML fields are rejected (`backend/internal/core/validator/registry_validator.go:975-995`; test `backend/internal/api/handlers/gate_invariant_test.go:240-250`). Fiber JSON body parsing is not configured to reject unknown JSON fields, and several handlers parse into maps, so request JSON is permissive (`backend/internal/api/handlers/handler.go:99-104`, `backend/internal/api/handlers/handler.go:272-275`).

## Variable resolution

`StateManager.Resolve` substitutes `{{...}}` immediately before dispatch; the next operation is `EvaluateResolvedStep`, then registry lookup and tool execution (`backend/internal/core/runner/executor.go:135-171`, `backend/internal/core/runner/state_manager.go:40-81`). The dispatch evaluator replays only deferred threshold/required rules plus a sensitive-key scan and cannot replay separation of duties, RBAC, process order, audit presence, or approval lifecycle (`backend/internal/core/validator/registry_validator.go:402-500`).

## Ranked bypasses

1. **CRITICAL — Baseline B HTTP-server bypass.** An operator or deployment actor who can set two environment values makes rejected writes execute against the configured MCP bridge; the included test proves the call occurs (`backend/internal/config/config.go:196-203`, `backend/cmd/server/main.go:170-173`, `backend/internal/api/handlers/gate_invariant_test.go:215-237`). Damage: any registered ERP write that policy would reject can be dispatched.
2. **CRITICAL — direct internal MCP/tool call.** Code in the backend can call exported `MCPClient.Execute` or a `Tool.Execute` implementation without presenting gate evidence (`backend/internal/tools/tool_interface.go:5-9`, `backend/internal/tools/mcp_client.go:60-101`). Damage: arbitrary registered bridge action with caller-supplied parameters.
3. **CRITICAL — approval-name substitution.** A plan passes high-risk approval rules merely by containing an action with `approve` or `approval`; no pause or distinct-principal record is checked (`backend/internal/core/validator/registry_validator.go:364-375`, `backend/internal/core/validator/registry_validator.go:898-905`). Damage: high-risk ERP write runs synchronously without human consent.
4. **HIGH — incomplete resolved-value revalidation.** Templated requester/approver identities and non-deferred policy inputs escape dispatch evaluation (`backend/internal/core/validator/registry_validator.go:353-361`, `backend/internal/core/validator/registry_validator.go:418-500`). Damage: runtime values can violate separation-of-duties rules that literal plan values would fail.
5. **HIGH — retry duplication.** A client retry creates a new execution and resends side effects without a key (`backend/internal/api/handlers/execute_handler.go:457-469`, `backend/internal/tools/mcp_client.go:69-83`). Damage: duplicate purchase orders, postings, notifications, or other writes after ambiguous timeouts.
