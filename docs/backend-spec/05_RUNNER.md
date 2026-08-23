# Execution runner specification

## 5.1 Pre-flight: request to first step

Execution is initiated synchronously by `POST /workflows/:id/run` or retry. The ordered preflight is:

1. Parse `RunWorkflowRequest`; normal run rejects malformed JSON, whereas retry deliberately ignores parse failure and uses zero values. [backend/internal/api/handlers/execute_handler.go:21-27](../../backend/internal/api/handlers/execute_handler.go) [backend/internal/api/handlers/execute_handler.go:468-480](../../backend/internal/api/handlers/execute_handler.go)
2. Load workflow or return 404. Enforce assignment when the actor has only own-run authority, or return 403. Refuse status `draft-unvalidated` with 422 before parsing. [backend/internal/api/handlers/execute_handler.go:29-40](../../backend/internal/api/handlers/execute_handler.go)
3. Run preliminary `WorkflowValidator.ValidateYAML`; a failure returns 422 with the old validation result and does not create an execution. [backend/internal/api/handlers/execute_handler.go:41-44](../../backend/internal/api/handlers/execute_handler.go)
4. Run `RegistryValidator.ValidateAndIssueToken("RunWorkflow", workflow.YAML, currentRole)`. Internal error maps to 500; full-gate rejection maps to 422 in production. A pass returns a token bound to exact content/registry. In an experiment build with Baseline B enabled, rejection is audited and allowed to continue with a nil token. [backend/internal/api/handlers/execute_handler.go:45-54](../../backend/internal/api/handlers/execute_handler.go) [backend/internal/api/handlers/execute_mode_production.go:1-13](../../backend/internal/api/handlers/execute_mode_production.go) [backend/internal/api/handlers/execute_mode_experiment.go:11-23](../../backend/internal/api/handlers/execute_mode_experiment.go)
5. If `dryRun=true`, return the full validation plus each parsed step's raw ID/action/parameters. No execution record, variable resolution, dispatch revalidation, or tool call occurs. [backend/internal/api/handlers/execute_handler.go:55-61](../../backend/internal/api/handlers/execute_handler.go)
6. Generate `run-` plus four random bytes in hexadecimal, create a `RUNNING` execution with workflow identity, UTC start and actor, and store a value copy immediately. This is the only durable evidence written before the runner begins. [backend/internal/api/handlers/execute_handler.go:63-73](../../backend/internal/api/handlers/execute_handler.go)
7. Call `Runner.Run` on the request goroutine with Fiber's context, workflow value copy, request input, and token. [backend/internal/api/handlers/execute_handler.go:75-75](../../backend/internal/api/handlers/execute_handler.go)
8. Runner recomputes the raw-YAML content hash and, in order, rejects missing token, invalid HMAC, content mismatch, then active-registry mismatch. Production returns an empty `Result` and error before parsing/state initialization. Experiment Baseline B audits and bypasses each block. [backend/internal/core/runner/executor.go:49-59](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/executor.go:173-190](../../backend/internal/core/runner/executor.go)
9. Strictly reparse the exact stored YAML. Decode failure returns `validated workflow content cannot be decoded: ...` before state initialization. [backend/internal/core/runner/executor.go:56-59](../../backend/internal/core/runner/executor.go)
10. Initialize state `{workflowID,executionID,variables:{input:<request input>},startedAt}`. Nil variables would be normalized to an empty map. Initialize empty log/timeline slices, a state reference, zero token counters, and an execution-local analysis cache. [backend/internal/core/runner/executor.go:61-76](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/state_manager.go:13-21](../../backend/internal/core/runner/state_manager.go)

There is no separate token-to-workflow hash comparison between token issue and creation beyond the runner check, but mutation handlers use analogous comparisons before writes. The workflow passed to the runner is a value copy; the YAML and token therefore refer to the same handler-read snapshot. [backend/internal/api/handlers/execute_handler.go:65-75](../../backend/internal/api/handlers/execute_handler.go)

## 5.2 Exact step loop

Steps execute sequentially in YAML order. `condition`, `onError`, and `retryCount` fields are not read by the runner; there is no branch skipping, tool retry, or on-error continuation. [backend/internal/core/runner/executor.go:78-167](../../backend/internal/core/runner/executor.go) [backend/internal/models/workflow.go:33-48](../../backend/internal/models/workflow.go)

### Common start

For each index, capture UTC `stepStart` and construct an in-memory timeline entry:

```text
id        = "step_" + 1-based index padded to three digits
nodeId    = blueprint step ID
label     = description; else type + ": " + action; else "analysis: " + ID; else action
status    = RUNNING
startedAt = stepStart
```

The entry is not appended to the returned timeline or durable store at this point. [backend/internal/core/runner/executor.go:78-87](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/executor.go:202-212](../../backend/internal/core/runner/executor.go)

### Tool step sequence

1. Recursively resolve a copy of the step parameter map against current variables.
2. Overwrite/add reserved parameter `_action` with the blueprint action.
3. Call the dispatch gate with action `dispatch.<executionID>`, exact workflow YAML, step index, resolved parameters including `_action`, and token. This rechecks proof/content/current registry/index, credential-like keys, and deferred rules; on success it mints a capability bound to the same parameter map. [backend/internal/core/runner/executor.go:118-120](../../backend/internal/core/runner/executor.go) [backend/internal/core/validator/registry_validator.go:409-523](../../backend/internal/core/validator/registry_validator.go)
4. On policy violation in production, timestamp completion, calculate integer milliseconds, change the local entry `RUNNING→FAILED`, append it, append one error log with the policy error and metadata `{action,rule_id,param_key}`, and return the partial result/error. The offending value in the typed error is at most its first four trimmed runes plus ellipsis (values of four or fewer are retained in full). [backend/internal/core/runner/executor.go:121-137](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/executor.go:193-200](../../backend/internal/core/runner/executor.go)
5. Resolve the implementation with an exact string lookup in the runtime tool registry. A missing implementation uses the configured fallback if nonnil; otherwise returns `tool "<name>" is not registered`. This error returns immediately without completing/appending the current timeline entry or writing a step log. [backend/internal/core/runner/executor.go:138-142](../../backend/internal/core/runner/executor.go) [backend/internal/tools/registry.go:34-46](../../backend/internal/tools/registry.go)
6. Call `tool.Execute(ctx, capability, params)` on the same goroutine. The MCP implementation then independently checks capability usability, action, and exact outgoing JSON hash before network dispatch. [backend/internal/core/runner/executor.go:144-144](../../backend/internal/core/runner/executor.go) [backend/internal/tools/mcp_client.go:53-83](../../backend/internal/tools/mcp_client.go)
7. Capture completion/duration. On tool error, change the local entry to `FAILED`, append it, append one error log containing the raw error and metadata `{action}`, and return partial result wrapped as `step <id> failed: <cause>`. No output is saved. [backend/internal/core/runner/executor.go:145-158](../../backend/internal/core/runner/executor.go)
8. On success, save the returned map under state variable `<step.ID>`, change entry to `DONE`, append it, and append one info log. Log metadata is the tool result with recursively secret-shaped fields removed; state initially retains the unredacted tool result until the handler derives redacted durable outputs. [backend/internal/core/runner/executor.go:160-166](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/state_manager.go:75-80](../../backend/internal/core/runner/state_manager.go)

### Analysis step sequence

Analysis steps set timeline `sideEffect=false` and never request a dispatch capability. [backend/internal/core/runner/executor.go:88-91](../../backend/internal/core/runner/executor.go)

1. Resolve the step's single `input` expression. Any remaining nested string containing both braces rejects before provider dispatch.
2. JSON-encode it. Apply limits: zero means defaults of 200 top-level collection items and 20,000 Unicode runes in encoded JSON; negative values were rejected by the gate. Scalars count as one item.
3. Run analysis-egress policy checks before testing provider availability. On violation return `ErrDataEgressViolation` holding only a bounded redaction.
4. Require a configured analysis provider.
5. JSON-encode output schema and create cache key `SHA256(instruction + NUL + inputJSON + NUL + schemaJSON + NUL + model)`, lowercase hex without prefix. Cache scope is this one workflow execution.
6. On cache hit, return cached output with zero tokens and `cached=true`.
7. Build the exact prompt sections `SYSTEM`, optional `CORRECTION`, `INSTRUCTION`, `OUTPUT_SCHEMA`, `INPUT`. Call the provider. A provider error ends immediately without retry and deliberately omits the underlying error text.
8. Count input/output tokens only when provider response says `Measured=true`. Decode exactly one JSON value with `UseNumber`, then validate against output schema. On first decode/schema failure, call the provider once more with a correction sentence. A second failure returns `...failed schema validation after one retry`.
9. Cache a valid decoded output and return aggregate measured tokens from one or two calls. [backend/internal/core/runner/analysis.go:48-145](../../backend/internal/core/runner/analysis.go) [backend/internal/core/runner/analysis.go:147-192](../../backend/internal/core/runner/analysis.go)

Back in the loop, failure completes/appends `FAILED` with `sideEffect=false`, logs error metadata `{kind:"analysis",sideEffect:false}`, and returns. Success saves state `<step.ID> = {output:<decoded value>}`, accumulates execution tokens, completes/appends `DONE`, and logs `{kind,sideEffect:false,cached,inputTokens,outputTokens}`. [backend/internal/core/runner/executor.go:91-115](../../backend/internal/core/runner/executor.go)

After all steps, the runner refreshes the result's state snapshot and returns nil error. Because `Snapshot` returns the live map rather than a copy, successful saves are also visible in the initially assigned `Result.State` on early return. [backend/internal/core/runner/executor.go:71-76](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/executor.go:169-170](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/state_manager.go:79-80](../../backend/internal/core/runner/state_manager.go)

## 5.3 Variable resolution

Supported reference tokens match `{{ <path> }}` where path contains only ASCII letters, digits, underscore, dot, or hyphen. Dot splits map keys; traversal supports only `map[string]interface{}` and has no array-index syntax. Initial root is `input`; every completed tool/analysis step adds a root keyed by step ID. [backend/internal/core/runner/state_manager.go:11-29](../../backend/internal/core/runner/state_manager.go) [backend/internal/core/runner/state_manager.go:59-77](../../backend/internal/core/runner/state_manager.go)

Resolution is recursive for lists and string-keyed maps:

- If a trimmed string consists entirely of one reference and lookup succeeds, return the resolved value with its original type (map, list, number, boolean, null, or string).
- Otherwise replace every matching reference embedded in the string with `fmt.Sprint(value)` and return a string.
- If lookup fails, retain the original `{{...}}` substring. Unsupported template syntax is likewise retained.
- Non-string scalar values pass through unchanged. [backend/internal/core/runner/state_manager.go:32-57](../../backend/internal/core/runner/state_manager.go) [backend/pkg/parser/regex_util.go:9-58](../../backend/pkg/parser/regex_util.go)

There is no global “all variables resolved” rejection for tool steps. A remaining reference is rejected only when a deferred required/threshold/confidentiality rule evaluates that parameter; otherwise it may reach the tool as a literal string. Analysis input always rejects any remaining nested brace pair. [backend/internal/core/validator/registry_validator.go:526-550](../../backend/internal/core/validator/registry_validator.go) [backend/internal/core/runner/analysis.go:48-53](../../backend/internal/core/runner/analysis.go)

## 5.4 State machines

### Execution

Defined status strings are `PENDING`, `RUNNING`, `DONE`, `FAILED`, `HEALING`, and workflow-only `draft-unvalidated`. The run path actually uses:

```text
(no record) → RUNNING → DONE
                      ↘ FAILED
                      ↘ HEALING → FAILED   (local status during synchronous repair)
```

The initial `RUNNING` copy is stored before execution. `HEALING` is assigned only to the local execution object and is reset to `FAILED` before the completed copy is persisted, so normal observers do not receive a durable healing state. [backend/internal/models/workflow.go:8-17](../../backend/internal/models/workflow.go) [backend/internal/api/handlers/execute_handler.go:63-73](../../backend/internal/api/handlers/execute_handler.go) [backend/internal/api/handlers/execute_handler.go:87-133](../../backend/internal/api/handlers/execute_handler.go)

`PENDING` is used for workflows and terminal-metrics interpretation but new execution records do not enter it. There is no transition function and no illegal-transition rejection; statuses are plain strings assigned directly. [backend/internal/api/handlers/execute_handler.go:537-550](../../backend/internal/api/handlers/execute_handler.go) [backend/internal/models/workflow.go:58-79](../../backend/internal/models/workflow.go)

### Step

The runner creates each attempted entry as `RUNNING` and appends it only as `DONE` or `FAILED`. A runtime-registry lookup failure can return while the current local entry remains unappended `RUNNING`; prior entries remain. No transition validator exists. [backend/internal/core/runner/executor.go:78-87](../../backend/internal/core/runner/executor.go) [backend/internal/core/runner/executor.go:121-166](../../backend/internal/core/runner/executor.go)

## 5.5 Completion, outputs, and error classification

After `Runner.Run`, the handler always stamps completion/duration/tokens. It copies state outputs onto timeline entries and derives `stepOutputs` plus `finalOutput` from the last `DONE` timeline entry, including partial outputs after failure. Analysis `{output:...}` wrappers are unwrapped. Nested credential-shaped fields are removed before durable storage. [backend/internal/api/handlers/execute_handler.go:75-96](../../backend/internal/api/handlers/execute_handler.go) [backend/internal/api/handlers/execute_handler.go:186-235](../../backend/internal/api/handlers/execute_handler.go)

Classification is ordered:

1. `ErrDispatchPolicyViolation` → `POLICY_VIOLATION`, rule/key, `toolWasCalled=false`, registry message.
2. `ErrDataEgressViolation` → same category; failed tool name becomes `analysis`.
3. No `FAILED` timeline entry → `VALIDATION`, `toolWasCalled=false` (covers token, strict reparse, and runtime registry lookup failure).
4. `MCPHTTPError`: 400 → `INVALID_REQUEST`; 401/403 → `AUTH_DENIED`; 404 → `NOT_FOUND`; 5xx → `TRANSIENT`; other status → default `TOOL_FAILURE`.
5. `context.DeadlineExceeded`, any `*url.Error`, or any `net.Error` → `TRANSIENT`.
6. Everything else → `TOOL_FAILURE`.

The default assumes `toolWasCalled=true`; only the first three paths reset it. [backend/internal/api/handlers/execute_handler.go:241-321](../../backend/internal/api/handlers/execute_handler.go)

Failed step detail selects the last failed timeline step, or the next blueprint step after completed entries; if none, uses `unknown`. Both analysis and tool failures ultimately return HTTP 422. Auth-denied receives a special message; all other failures expose the classified step/tool and runner error. [backend/internal/api/handlers/execute_handler.go:360-375](../../backend/internal/api/handlers/execute_handler.go) [backend/internal/api/handlers/execute_handler.go:175-183](../../backend/internal/api/handlers/execute_handler.go)

The completed execution, logs, timeline, metrics, failure-classification audit, and success audit are written under one store lock. There is no separate `execution.failed` audit; failures get `execution.failure.classified`. [backend/internal/api/handlers/execute_handler.go:136-173](../../backend/internal/api/handlers/execute_handler.go)

## 5.6 Healing

Only `TRANSIENT` failures with a nonnil healer enter repair. Policy/data-egress violations are explicitly excluded because they were governance blocks before dispatch/model egress; they also do not receive a `HEALING_NOT_ATTEMPTED` report. Other terminal failures receive that report when healing is unavailable/inapplicable. [backend/internal/api/handlers/execute_handler.go:87-131](../../backend/internal/api/handlers/execute_handler.go)

The healer has `MaxAttempts=1`. `MaxAttempts<=0` returns the execution error; any positive value still performs exactly one synthesis call—there is no loop. It prompts with workflow name as “original request,” full failing YAML, and execution error, and asks the synthesizer for strict YAML repair. [backend/internal/core/healing/error_loop.go:11-40](../../backend/internal/core/healing/error_loop.go)

If synthesis fails, store `REPAIR_FAILED`. If it produces YAML, run the complete registry gate with action `HealingRepair`; attach that validation result to the optional healing event. A rejection stores `REPAIR_REJECTED`. A pass replaces the stored workflow's YAML and stores `VALIDATED_REPAIR_AVAILABLE`. It does not refresh canvas, domains, versions, draft/status fields, or audit a workflow update. [backend/internal/api/handlers/execute_handler.go:98-125](../../backend/internal/api/handlers/execute_handler.go)

The repaired workflow is never automatically re-run. The original execution is always finalized `FAILED`, even when repair passes. A later explicit run will revalidate and execute the modified YAML. [backend/internal/api/handlers/execute_handler.go:108-126](../../backend/internal/api/handlers/execute_handler.go)

## 5.7 Concurrency, timeouts, and durability

The entire run—including every tool/provider call and optional repair—holds the HTTP request goroutine. Steps are strictly sequential; the runner starts no goroutines. Tool calls receive the request context, but there is no runner-level workflow/step timeout and `retryCount` is ignored. MCP's configured HTTP client timeout and provider implementations are the effective external-call bounds. [backend/internal/core/runner/executor.go:49-170](../../backend/internal/core/runner/executor.go) [backend/internal/tools/mcp_client.go:41-47](../../backend/internal/tools/mcp_client.go)

All run mutations are additionally wrapped by the global persistence middleware. In durable mode it holds a persistence mutex across the complete synchronous handler and flushes after return, serializing mutation requests for the duration of external calls. The repository mutex itself is held only around individual state batches, not tool calls. [backend/internal/api/middlewares/persistence.go:31-63](../../backend/internal/api/middlewares/persistence.go) [backend/internal/api/handlers/execute_handler.go:70-75](../../backend/internal/api/handlers/execute_handler.go)

On process crash after initial insertion but before completion, durable storage can contain `RUNNING` with no timeline/logs/output because intermediate steps are not persisted during the loop. In memory-only mode the entire store is lost. [backend/internal/api/handlers/execute_handler.go:63-84](../../backend/internal/api/handlers/execute_handler.go) [backend/internal/core/runner/executor.go:78-170](../../backend/internal/core/runner/executor.go)

Before the server accepts traffic, startup reconciliation scans every persisted `RUNNING` execution, sets `FAILED`, stamps completion/duration (clamped to zero), appends an error log with reason `process_restarted_mid_run`, and recalculates affected workflow success metrics. It does not reconstruct partial step progress, classify a failure object, heal, or resume dispatch. [backend/internal/api/handlers/execute_handler.go:555-615](../../backend/internal/api/handlers/execute_handler.go) [backend/cmd/server/main.go:101-104](../../backend/cmd/server/main.go)
