# Full System Test Report

Test date: 2026-08-02  
Repository: `low-code-workflow-engine`  
Scope: build, test, trace, and report only; no source-code fix was made.

## 1. Executive summary

The deterministic validation gate is unchanged and the system's mock-MCP governed demo path is operational. Backend build, vet, the complete Go suite, the complete Jest suite, and the production frontend build passed. The frontend is not fully clean because ESLint reports two errors and one warning. Live Gemini accuracy was not run because the required opt-in credentials/flag were unavailable; those tests are recorded as skips, not passes.

Requested function matrix totals (Sections 2 and 3 only):

| Status | Count |
|---|---:|
| PASS | 26 |
| FAIL | 6 |
| PARTIAL | 15 |
| UNVERIFIED | 0 |
| Total | 47 |

Safety gate at the start:

```text
cases=120 rows=240
MODE      TP  FP  TN  FN  RECALL  PRECISION  FNR     F1      MEAN_LATENCY_MS
gate_on    54   0  60   6  0.9000  1.0000     0.1000  0.9474  0.2086
gate_off    0   0  60  60  0.0000  0.0000     1.0000  0.0000  0.2652
```

Safety gate at the end:

```text
cases=120 rows=240
MODE      TP  FP  TN  FN  RECALL  PRECISION  FNR     F1      MEAN_LATENCY_MS
gate_on    54   0  60   6  0.9000  1.0000     0.1000  0.9474  0.2330
gate_off    0   0  60  60  0.0000  0.0000     1.0000  0.0000  0.3244
```

The classification counts and quality metrics match exactly at start and end. Only non-gating wall-clock latency varied.

The experiment's stated caveat is unchanged: all six gate-on false negatives are the `self_approval` probes because no enabled `separation_of_duties` rule exists; every other unsafe category has recall 1.0000.

Top three findings:

1. **P0 — LLM analysis steps are absent.** There is no runner branch for tool → LLM analysis → tool, no `output_schema` contract, and no analysis-specific data-egress enforcement. All four Section 2.8 functions are FAIL/MISSING.
2. **P1 — downstream authorization classification is incomplete and some response errors remain raw.** HTTP 401 maps to `AUTH_DENIED`, but 403 falls through to `TOOL_FAILURE` (`backend/internal/api/handlers/execute_handler.go:189-203`). Chat is sanitized, but settings probe failures still serialize `err.Error()` (`settings_handler.go:229,308,325`).
3. **P1 — verification debt remains.** Frontend lint fails at `CompanyPage.jsx:33,72`; live first-pass Gemini accuracy is opt-in and was skipped; several UI flows and registry update paths have only partial functional coverage.

Additional behavioral mismatch: public registration does **not** create the first Platform Admin. An empty installation requires environment bootstrap (`backend/internal/repository/bootstrap.go:12-36`) and `/auth/register` returns 503 until it has occurred (`auth_handler.go:83-88`). This is a secure design, but it does not satisfy the requested “register first user” function.

## 2. Build, vet, and automated-test evidence

### 2.1 Backend build and vet

Commands:

```powershell
cd backend
go build -buildvcs=false ./...
go vet ./...
```

Observed output:

```text
go build: exit 0; no output
go vet:   exit 0; no output
```

### 2.2 Complete backend suite

Command:

```powershell
go test ./... -count=1
```

Observed aggregate output from the structured test event stream:

```text
GO_TEST_TOTALS packages_passed=20 packages_failed=0 tests_passed=261 tests_failed=0 tests_skipped=5
```

The slow package completed rather than being truncated:

```text
ok  github.com/sanjeewa/agentic-orchestrator/tests/unit  77.866s
```

Packages reported with no test files: `cmd/generate-eval-dataset`, `cmd/run-experiment`, `cmd/server`, `internal/authn`, `internal/core/healing`, `internal/core/runner`, `internal/models`, `internal/tools/impl`, `pkg/logger`, `pkg/parser`, and `tests/mocks`.

Skip register from the full suite:

| Skipped test | Package | Exact reason | Follow-up |
|---|---|---|---|
| `TestGenerationFirstPassAccuracy20` | `internal/core/orchestrator` | `GEMINI_API_KEY is not set; the measured 20-request accuracy check is opt-in` | Not rerun; credential unavailable. |
| `TestRealProviderRegistryMarkdownDoesNotChangePromptTokens` | `internal/core/synthesizer` | `GEMINI_API_KEY not set; real provider telemetry opt-in` | Not rerun; credential unavailable. |
| `TestPostgresStoreEnforcesSingleWriterPerStateKey` | `internal/storage` | `TEST_DATABASE_URL not set` | Rerun separately against the available local PostgreSQL database: PASS. |
| `TestPostgresStoreRoundTrip` | `internal/storage` | `TEST_DATABASE_URL not set` | Rerun separately against the available local PostgreSQL database: PASS. |
| `TestGeminiLiveAPIGenerationAccuracyReport` | `tests/unit` | `requires RUN_GEMINI_LIVE_TEST=1 and GEMINI_API_KEY` | Not rerun; flag/credential unavailable. |

PostgreSQL rerun output (the connection string was read without printing it):

```text
=== RUN   TestPostgresStoreRoundTrip
--- PASS: TestPostgresStoreRoundTrip (0.14s)
=== RUN   TestPostgresStoreEnforcesSingleWriterPerStateKey
--- PASS: TestPostgresStoreEnforcesSingleWriterPerStateKey (0.14s)
PASS
```

Therefore, the unresolved skips after targeted reruns are the three explicit live-Gemini/telemetry checks.

### 2.3 Focused backend capability output

```text
--- PASS: TestRegisterDefaultsNewUsersToClientRole (0.12s)
--- PASS: TestRegistrationRefusesBeforeBootstrap (0.00s)
--- PASS: TestClientOwnScopeUnchanged (0.00s)
--- PASS: TestWorkflowWritePathsRejectInvalidDefinitionsWithoutPersistence (0.00s)
--- PASS: TestPublishAndRestoreRejectStoredInvalidYAML (0.00s)
--- PASS: TestUseTemplateInvalidResultDoesNotPersistOrCreateEmptyCanvas (0.00s)
--- PASS: TestUnknownYAMLFieldRejectedByStrictGate (0.00s)
--- PASS: TestGateDecisionsAreRecordedWithRequiredAuditEvidence (0.00s)
--- PASS: TestSystemAdminCannotReadProviderSecrets (0.00s)
--- PASS: TestProviderSecretsAreWriteOnlyAndActivationAffectsNextSynthesis (0.01s)
--- PASS: TestRegistryMutationPersistsSwapsHashRejectsOldTokenAndAudits (0.16s)
--- PASS: TestValidatorDoesNotDependOnContextPackage (0.96s)
--- PASS: TestCommitRollsBackOnPartialFailure (0.04s)
--- PASS: TestImportCommitRegeneratesContext (0.09s)
--- PASS: TestPersistentStoreEncryptedRestartRoundTrip (0.00s)
--- PASS: TestDemoModesAreExplicitAndValidated (0.00s)
--- PASS: TestMockErpBackendMarkerIsDetected (0.01s)
--- PASS: TestMCPClientMockModeExecutesDemoEchoDeterministically (0.00s)
--- PASS: TestMCPClientMockModeRefusesNonDemoAction (0.00s)
--- PASS: TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution (0.00s)
--- PASS: TestLiteralOverThresholdRejectedAtPlanTime (0.00s)
--- PASS: TestDeferredThresholdDispatch (0.00s)
--- PASS: TestResolvedSensitiveKeyAbortsBeforeTool (0.00s)
--- PASS: TestDeferredCheckWithoutEvaluatorFailsClosed (0.00s)
--- PASS: TestChatEndpointWithMockEmbeddingSearchAndGemini (0.13s)
--- PASS: TestGovernedDemoFlowThroughRealRoutes (0.48s)
--- PASS: TestMockErpNeverReachedByPolicyBlockedStep (0.01s)
```

Execution/failure-focused output:

```text
--- PASS: TestExecutionRecordsPolicyViolationCategory (0.00s)
--- PASS: TestPolicyViolationRecordsRuleIdParameterAndToolNotCalled (0.00s)
--- PASS: TestToolFailureRecordsToolFailureCategory (0.00s)
--- PASS: TestHealingResolvesToTerminalStatus (0.00s)
--- PASS: TestFailedRunReturns422WithStepAndTool (0.00s)
--- PASS: TestSuccessfulRunReturns200 (0.00s)
--- PASS: TestDispatchPolicyViolationStillFailedNeverHealed (0.00s)
--- PASS: TestSuccessRateCountsAllTerminalExecutions (0.00s)
--- PASS: TestStartupMarksOrphanedRunningExecutionsFailed (0.00s)
--- PASS: TestChatErrorDoesNotLeakUnderlyingError (0.00s)
--- PASS: TestMockErpHTTPFailuresAreClassifiedWithoutParsingText (0.00s)
    --- PASS: .../invalid (0.00s)
    --- PASS: .../auth (0.00s)
    --- PASS: .../notfound (0.00s)
    --- PASS: .../transient (0.00s)
    --- PASS: .../timeout (0.00s)
    --- PASS: .../unrecognised (0.00s)
```

The classification test has no 403 subtest. Source tracing confirms this is a real missing mapping, not merely missing coverage.

Temporary orchestration probe output:

```text
=== RUN   TestSystemProbeStepOutputFlowsToLaterStep
--- PASS: TestSystemProbeStepOutputFlowsToLaterStep (0.00s)
=== RUN   TestSystemProbeFailureStopsLaterSteps
--- PASS: TestSystemProbeFailureStopsLaterSteps (0.00s)
PASS
```

The temporary probe was used only to execute the missing multi-step behavior and was deleted immediately afterward. It made no production-code change and is not permanent regression coverage.

### 2.4 Frontend lint, tests, and build

Lint command/output:

```text
> agentic-workflow-frontend@0.1.0 lint
> eslint .

frontend/src/components/executions/ExecutionTimeline.jsx
  2:29  warning  'statusMetaFor' is defined but never used  no-unused-vars

frontend/src/pages/company/CompanyPage.jsx
  33:21  error  Calling setState synchronously within an effect  react-hooks/set-state-in-effect
  72:19  error  Calling setState synchronously within an effect  react-hooks/set-state-in-effect

✖ 3 problems (2 errors, 1 warning)
```

Frontend test output:

```text
Test Suites: 20 passed, 20 total
Tests:       37 passed, 37 total
Snapshots:   0 total
Time:        14.636 s
Ran all test suites.
```

Focused auth/routing/UI selection:

```text
Test Suites: 10 passed, 10 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        9.159 s
```

Production build output:

```text
vite v7.3.6 building client environment for production...
✓ 2170 modules transformed.
dist/assets/WorkflowBuilderCanvas-D2tLXWwK.js   13.24 kB │ gzip:  4.87 kB
dist/assets/RegistryImportPage-Xz2ZXZgq.js      13.49 kB │ gzip:  4.37 kB
dist/assets/UserListPage-Cw5D4pse.js            14.51 kB │ gzip:  4.50 kB
dist/assets/ChatPage-h52Sk9hf.js                 23.22 kB │ gzip:  6.53 kB
dist/assets/index-BgDx8Mul.js                    43.28 kB │ gzip: 12.83 kB
dist/assets/xyflow-BZcNlInA.js                  122.91 kB │ gzip: 39.97 kB
dist/assets/react-0LRAnK8o.js                   192.93 kB │ gzip: 60.53 kB
dist/assets/vendor-D2Zgw3PL.js                  289.86 kB │ gzip: 97.88 kB
✓ built in 7.93s
```

The main `index` chunk is 43.28 kB and the largest chunk is `vendor` at 289.86 kB.

## 3. Backend functional capability results

The CSV companion contains the same 38 backend function rows in machine-readable form.

### 3.1 Auth and identity

| Function | Status | Evidence | Result |
|---|---|---|---|
| Register first user → Platform Admin | FAIL | `auth_registration_test.go:16`; `auth_handler.go:83-88`; `bootstrap.go:12-36` | Empty-store registration is refused; environment bootstrap creates the Platform Admin. |
| Later registration → Client | PASS | `TestRegisterDefaultsNewUsersToClientRole` PASS | The default role is `role_client`. |
| Login + rotating refresh survives expiry/race | PASS | `auth_handler.go:50-69,160-191`; `refreshRotation.test.js:38-76`; `authRace.test.js:56-100` | Access and refresh tokens are issued; one refresh promise serializes concurrent 401s; 20 race iterations passed. |
| Under-permissioned request → 403 | PASS | `middlewares/rbac.go:8-16`; provider/registry/client acceptance tests PASS | Permission middleware returns a stable 403 denial. |

### 3.2 Validation gate (G1)

| Function | Status | Evidence | Result |
|---|---|---|---|
| Unknown tool blocked on all write paths | PASS | `TestWorkflowWritePathsRejectInvalidDefinitionsWithoutPersistence`; `TestPublishAndRestoreRejectStoredInvalidYAML`; `TestUseTemplateInvalidResultDoesNotPersistOrCreateEmptyCanvas` | Create, update, YAML put, publish, restore, and template use are covered. |
| Runner rejects invalid validation tokens | PASS | `runner_test.go:37-88`; `registry_handler_test.go:97-103`; `executor.go:163-179` | Nil, content mismatch, forged proof, and registry mismatch stop before tool execution. |
| Strict YAML unknown field | PASS | `TestUnknownYAMLFieldRejectedByStrictGate` PASS | Unknown fields are rejected. |
| Gate decision audit with registry hash | PASS | `TestGateDecisionsAreRecordedWithRequiredAuditEvidence` PASS | Required evidence is present. |

The runner entry check is explicit:

```go
// backend/internal/core/runner/executor.go:167-179
if !e.Validator.VerifyToken(token) { /* reject proof */ }
if contentHash != token.WorkflowContentHash { /* reject content mismatch */ }
if actual := e.Validator.RegistryHash(); actual != token.RegistryHash {
    /* reject registry mismatch */
}
```

### 3.3 Dispatch-time revalidation (G2)

| Function | Status | Evidence | Result |
|---|---|---|---|
| Literal over threshold rejected at plan time | PASS | `TestLiteralOverThresholdRejectedAtPlanTime` PASS | Plan validation blocks it. |
| Deferred under/over threshold | PASS | Both `TestDeferredThresholdDispatch` subtests PASS | Under executes; over aborts with zero tool calls. |
| Resolved sensitive key | PASS | `TestResolvedSensitiveKeyAbortsBeforeTool` PASS | Dispatch is blocked before the tool. |
| Missing deferred evaluator | PASS | `TestDeferredCheckWithoutEvaluatorFailsClosed` PASS | The gate fails closed. |

Resolution and G2 occur immediately before dispatch:

```go
// backend/internal/core/runner/executor.go:98-99,108-125,134
params := manager.Resolve(step.Parameters)
if violation := e.Validator.EvaluateResolvedStep(..., params, token); violation != nil {
    // records failure and returns before dispatch
}
toolResult, err := tool.Execute(ctx, params)
```

### 3.4 Execution runner and orchestration

| Function | Status | Evidence | Result |
|---|---|---|---|
| Step A output reaches step B | PASS | Temporary probe PASS; `state_manager.go:24-76`; `executor.go:87-150` | The complete response map is saved under step ID and `{{step_a.field}}` resolves for the next step. |
| Failure stops later steps | PASS | Temporary probe PASS; `executor.go:140-148` | Runner returns immediately; later spy calls remain zero. |
| HTTP failure classification | FAIL | Classification test PASS for 400/401/404/5xx/timeout; `execute_handler.go:189-203` | 403 is not mapped to `AUTH_DENIED`. |
| Only transient is healable | PASS | `execute_handler.go:98-131,189-209` | Healing entry condition is exactly `FailureCategoryTransient`. |
| Failure message and upstream secrecy | PARTIAL | `TestFailedRunReturns422WithStepAndTool`; MCP payload-discard test; `execute_handler.go:144-146,260-272` | Step/tool are named and MCP body is not exposed, but generic `runErr.Error()` is appended. |

Exact data-flow storage and resolution:

```go
// backend/internal/core/runner/state_manager.go:24-29,75-76
for key, value := range params {
    out[key] = resolveValue(value, m.state.Variables)
}
m.state.Variables[stepID] = result
```

Confirmed classification gap:

```go
// backend/internal/api/handlers/execute_handler.go:191-202
case downstream.StatusCode == 400:
    failure.FailureCategory = models.FailureCategoryInvalidRequest
case downstream.StatusCode == 401:
    failure.FailureCategory = models.FailureCategoryAuthDenied
case downstream.StatusCode == 404:
    failure.FailureCategory = models.FailureCategoryNotFound
case downstream.StatusCode >= 500 && downstream.StatusCode <= 599:
    failure.FailureCategory = models.FailureCategoryTransient
default:
    // 403 reaches this terminal TOOL_FAILURE fallback.
```

### 3.5 Self-healing

| Function | Status | Evidence | Result |
|---|---|---|---|
| Bounded repair/full-gate validation/terminal state | PARTIAL | `TestHealingResolvesToTerminalStatus` PASS; `execute_handler.go:98-126` | The failed-repair branch is tested and never remains HEALING. Valid repaired YAML is full-gate checked but recorded as available rather than re-executed; no positive repair test exists. |
| Policy violation never heals | PASS | `TestDispatchPolicyViolationStillFailedNeverHealed`; tool-not-called category test | No healing report and zero tool calls. |

Terminal resolution is explicit at `execute_handler.go:126`: `execution.Status = models.StatusFailed`.

### 3.6 Registry management

| Function | Status | Evidence | Result |
|---|---|---|---|
| Tool add/edit mutation invariants | PARTIAL | `TestRegistryMutationPersistsSwapsHashRejectsOldTokenAndAudits` PASS; `registry_handler.go:22-49` | Add is proven end-to-end; edit success lacks the same integration assertions. |
| Rule add/edit mutation invariants | PARTIAL | `registry_handler.go:90-117`; governed demo rule create PASS | Rule create affects real dispatch, but edit + persistence + hash + old-token rejection is not one tested flow. |
| Bulk import all-or-nothing | PASS | `TestCommitRollsBackOnPartialFailure` PASS; `importer_test.go:194-218` | Both files and live manager are restored. |
| Markdown regeneration and validation boundary | PASS | `TestImportCommitRegeneratesContext`; `TestRegistryCRUDRegeneratesContext`; `TestValidatorDoesNotDependOnContextPackage` | Runtime MD regenerates; validator's full transitive dependencies exclude context. |

The transitive boundary test executes:

```go
// backend/internal/core/context/import_boundary_test.go:15-23
command := exec.Command("go", "list", "-deps",
    "github.com/sanjeewa/agentic-orchestrator/internal/core/validator")
// fails if internal/core/context appears
```

Current generated files are routed under the runtime registry directory (`context/service.go:309-311`): `generated/registry_context.md` and the hash-suffixed archive.

### 3.7 Providers and generation

| Function | Status | Evidence | Result |
|---|---|---|---|
| Provider types + write-only API key | PARTIAL | Provider acceptance test PASS; governed Gemini configuration PASS; synthesizer usage tests pass | OpenAI-compatible and Gemini endpoint creation are exercised; no Ollama create-endpoint test was found. Secret create/list/audit responses are tested. |
| Activation changes next synthesis | PASS | `provider_handler_test.go:79-103` | Before/after synthesis uses different active providers. |
| Test connection | PASS | `provider_handler_test.go:106-110`; `provider_handler.go:130-148` | Success asserted; failure returns stable `ok:false`. |
| Gate-passing generation and live accuracy | PARTIAL | Mock Gemini integration PASS; two live accuracy tests SKIP | Mock provider selects executable candidate; measured live accuracy remains unverified. |

The public provider view has `keyPreview`, not `apiKey` (`provider_handler.go:21-30,188-192`). Handler-level Platform Admin enforcement is at `provider_handler.go:213-220`, in addition to route middleware.

### 3.8 Analysis steps

| Function | Status | Evidence | Result |
|---|---|---|---|
| tool → LLM analysis → tool | FAIL | `models/workflow.go:28-37`; `runner/executor.go:87-150` | MISSING. All steps are dispatched through the tool registry. |
| `output_schema` and declared-input validation | FAIL | Repository search found no analysis `output_schema` implementation/test | MISSING. |
| Analysis data-confidentiality blocks provider | FAIL | General `data_confidentiality` rules exist, but no analysis provider path/test exists | MISSING. |
| No-evaluator analysis rule fails closed | FAIL | No analysis step kind/executor exists | MISSING. |

`WorkflowStepBlueprint.Type` is only used for labels (`executor.go:192-199`); it does not select an LLM-analysis executor.

### 3.9 Client scoping

| Function | Status | Evidence | Result |
|---|---|---|---|
| Owned/assigned workflows only | PASS | `TestClientOwnScopeUnchanged`; `client_scope_test.go:61-90` | Two-user ownership and assignment passed. |
| Other executions/chats denied | PASS | `client_scope_test.go:92-112` | Cross-user resources are hidden with 404. |
| Registry/provider/user edits denied | PASS | `routes.go:107-119,145-160,182-186`; import/provider/registry denial assertions | Route permissions plus provider handler hierarchy enforce 403. |

### 3.10 Persistence

| Function | Status | Evidence | Result |
|---|---|---|---|
| PostgreSQL restart/encryption | PARTIAL | Both PostgreSQL focused tests PASS; `postgres_test.go:14-61,74-97`; persistent restart test PASS | Real PostgreSQL encrypted round-trip and generic encrypted repository restart are proven separately, not as one full server restart. |
| Memory mode suite | PASS | Complete Go suite: 261 PASS, 0 FAIL | Default memory mode is green. |

`TestPostgresStoreRoundTrip` encrypts the state before save, verifies the stored payload contains no plaintext credential, reloads it, and decrypts it (`internal/storage/postgres_test.go:32-59`). `TestPersistentStoreEncryptedRestartRoundTrip` restores users, auth sessions, workflows, executions, chats, providers, and secret settings after constructing a new repository over persisted ciphertext (`internal/repository/persistent_store_test.go:61-145`).

### 3.11 Demo path

| Function | Status | Evidence | Result |
|---|---|---|---|
| Mock mode safety controls | PASS | Config and MCP focused tests PASS; `config.go:205-224`; mock ERP gate test PASS | Remote is default, mock is explicit, production refuses it, and the gate runs before dispatch. |
| Safe/unsafe governed run | PARTIAL | `TestGovernedDemoFlowThroughRealRoutes` PASS; `demo_flow_test.go:99-123` | Safe DONE and unsafe FAILED/tool-not-called are proven with amounts 25/125, not the requested exact 10/150. |

The real-route demo test covers Platform Admin login, provider configuration without credential echo, builder/client creation, rule creation, workflow creation, assignment, client login, safe execution, and policy-blocked unsafe execution.

## 4. Frontend functional coverage

| Function | Status | Component evidence | Test evidence / gap |
|---|---|---|---|
| Login/register, client role, forbidden screen | PARTIAL | `pages/auth/LoginPage.jsx:25`; `RegisterPage.jsx:25`; `config/router.jsx:99-109` | Permission route test PASS. Auth storage/race tests PASS. No page-level login/register interaction test. |
| Navigation filtered per role | PASS | `constants/navigation.js`; `constants/navigation.test.js:7-61` | Admin, system admin, client, and no-permission tests pass; visible entries match permitted routes. |
| Chat generate → artifact | PARTIAL | `pages/chat/ChatPage.jsx:29-74` | Backend chat/generation integration passes; no frontend send-to-artifact DOM test. |
| Canvas writable/read-only | PASS | `WorkflowBuilderCanvas.jsx:520-560`; `WorkflowBuilderPage.jsx:5-8` | Tool catalog and role-specific controls tests pass. |
| Workflows/run/history/detail failure | PARTIAL | `WorkflowListPage.jsx:14-49`; `WorkflowDetailPage.jsx:12-47`; `ExecutionDetailPage.jsx:11-47` | Run input, deep link, policy block, tool failure, badges, and timeline tested; no complete list→detail→run→history UI test. |
| Registry tools/rules/add/import | PARTIAL | `RegistryPage.jsx:71-207`; `RegistryImportPage.jsx:189-353` | Pages are real and build; backend import is tested; frontend add/import interactions are not. |
| Providers/models | PARTIAL | `ModelsPage.jsx:20-143` | Add/edit/activate/test/keyPreview controls exist; backend is tested; ModelsPage DOM interactions are not. |
| Users admin | PARTIAL | `UserListPage.jsx:52-157`; `UserForm.jsx:9-35`; `RoleCreateForm.jsx:14-102` | Create and permission filtering tested; assign/suspend/reactivate/delete are not page-level tested. The page is not read-only. |
| Settings | PARTIAL | `SettingsPage.jsx:9-94` | Loading, error, empty, and data views compile; no functional test. |

Routing foundation evidence:

```text
routes.deeplink.test             PASS
routes.permission.test           PASS
routes.allNavEntriesRouted       PASS
lazyRoutes.test                  PASS
errorBoundary.test               PASS
```

All protected route elements are lazy and permission-checked (`frontend/src/config/router.jsx:17-89,99-109`). Forbidden routes render `UnauthorizedPage`; they do not redirect to the dashboard.

## 5. Security spot-check

| Check | Status | Evidence | Result |
|---|---|---|---|
| Tracked `AIza` scan | PASS | Sanitized execution of `git grep -n -I "AIza" -- '*.go' '*.md' '*.env*'` | `NO_HITS`. No candidate secret value was printed. |
| API endpoints echoing provider API keys | PASS for provider endpoints | `TestProviderSecretsAreWriteOnlyAndActivationAffectsNextSynthesis`; `provider_handler.go:21-30,188-199` | Create/list/audit responses exclude `apiKey`; only `keyPreview` and a credential-configured boolean are public. |
| Gemini credential transport | PASS | `TestGeminiGenerateUsesHeaderAuthentication` PASS; `gemini_client.go:72`; redirect test passed in full suite | Uses `x-goog-api-key` header, not URL query, and does not forward the header across redirects. |
| MCP downstream error body | PASS | `TestMCPClientRemoteErrorDoesNotExposeDownstreamPayload` PASS; `mcp_client.go:28-36,89-93` | Only status code survives; response body is deliberately discarded. |
| WebSocket token in URL query | KNOWN FINDING | `middlewares/auth.go:18-22`; `routes.go:14` | `/ws/*` accepts `?token=` because browser WebSocket clients cannot set Authorization. Limit exposure with short-lived, audience-scoped WebSocket tickets and ensure access logs redact the query. |
| Chat raw internal error | PASS | `TestChatErrorDoesNotLeakUnderlyingError`; `chat_handler.go:252-257` | Detail is logged server-side with trace ID; browser receives a stable message. |
| Settings raw internal error | FAIL | `settings_handler.go:174,196,229,308,325` | Two URL-validation paths and three webhook/integration probe paths return `err.Error()` to the browser. |

Sanitized secret-scan output:

```text
AIza_SCAN=NO_HITS
```

No API key or credential value is reproduced anywhere in this report.

## 6. Ranked findings and fix suggestions

### P0 — Analysis-step execution is missing

Evidence: `WorkflowStepBlueprint` has generic `Type`, `Action`, and `Parameters` (`models/workflow.go:28-37`), but the runner resolves every step and looks up `step.Action` in the tool registry (`runner/executor.go:87-150`). Searches for an analysis executor and `output_schema` validation found none.

Suggested fix: introduce a typed, strict analysis-step contract; validate declared inputs and output schema at G1; enforce data-egress rules at dispatch before provider invocation; fail closed without an evaluator; validate LLM output against the schema; then permit only declared fields downstream. Add provider-not-called spies and end-to-end tool→analysis→tool tests.

### P1 — HTTP 403 is not `AUTH_DENIED`

Evidence: `execute_handler.go:189-203` maps 400, 401, 404, and 5xx but omits 403. The focused classification test also has no 403 subtest.

Suggested fix: add 403 beside 401 in the typed `MCPHTTPError` switch and add an explicit test asserting terminal `AUTH_DENIED`, no healing, and exactly one attempted tool call.

### P1 — Raw operational errors can reach settings responses

Evidence: `settings_handler.go:229,308,325` puts `err.Error()` into JSON for webhook/integration probe failures; lines 174 and 196 return raw URL-validation errors.

Suggested fix: log the underlying error with a trace ID; return a stable public sentence plus that trace ID. Keep user-actionable field validation precise but do not expose network/internal diagnostics.

### P1 — Frontend lint is red

Evidence: `npm run lint` exits 1 with `react-hooks/set-state-in-effect` at `CompanyPage.jsx:33,72`; `ExecutionTimeline.jsx:2` has an unused import warning.

Suggested fix: derive editable state from query data without synchronous effect-state mirroring, reset the form on an explicit data/version event, and remove the unused import. No fix was made in this assessment pass.

### P1 — First-user behavior differs from the requested registration flow

Evidence: `/auth/register` returns service unavailable on an empty store (`auth_handler.go:83-88`); `BootstrapPlatformAdmin` requires bootstrap environment variables (`bootstrap.go:12-36`).

Suggested fix: document and demonstrate bootstrap as the supported first-user path. Do not silently change registration to create a privileged user; if a guided setup UI is required, design an explicit one-time bootstrap ceremony.

### P2 — Important successful update paths lack regression tests

Evidence: tool create mutation is comprehensively tested, but no equivalent successful `UpdateTool` test was found; rule create/edit does not have one test proving persistence, snapshot/hash swap, and old-token rejection together.

Suggested fix: add table-driven tool/rule create-and-update tests over temporary runtime registries, preserving the same invariant assertions as `TestRegistryMutationPersistsSwapsHashRejectsOldTokenAndAudits`.

### P2 — Live generation accuracy remains unmeasured in this run

Evidence: three provider-dependent tests remain skipped with explicit opt-in reasons.

Suggested fix: run the live suite in a controlled CI/manual environment using an injected secret, retain only aggregate metrics, and classify provider 5xx as an external outage rather than weakening assertions.

### P2 — UI interaction coverage is incomplete

Evidence: routing, navigation, canvas, auth races, workflow run input, and failure rendering are tested; Chat artifact display, ModelsPage, registry import UI, complete user lifecycle, SettingsPage, and the full workflow history path are not directly exercised.

Suggested fix: add focused Testing Library tests for each mutation and a browser smoke test covering login→configure→create client→assign→run→inspect block.

### P2 — PostgreSQL evidence is split across abstraction tests

Evidence: the real database test proves encrypted payload round-trip; the repository restart test proves full-data restoration using the same `StateStore` interface, but no single test closes and reopens PostgreSQL with a populated repository.

Suggested fix: add an opt-in PostgreSQL test that builds `NewPersistentStore`, writes representative domain data, closes the backend, reopens it with the same state key, verifies restoration, and confirms ciphertext-at-rest without logging the DSN.

### P3 — Exact demo threshold values are not the requested pair

Evidence: `demo_flow_test.go:99-123` uses safe 25 and unsafe 125, while the assessment requested 10 and 150.

Suggested fix: parameterize the real-route demo test with boundary-representative values including the exact rehearsal pair; do not weaken the policy assertion.

## 7. Demo-readiness verdict

**Qualified READY for the governed mock-MCP demo.** `TestGovernedDemoFlowThroughRealRoutes` passed the real HTTP route chain: privileged login → write-only provider configuration → builder/client creation → runtime rule creation → workflow creation/assignment → client login → safe DONE execution → unsafe FAILED execution with rule evidence and proof that the tool was not called.

The operator must use the documented environment bootstrap for the first Platform Admin; first-user public registration is not supported. The demo must use mock/standalone mock ERP unless a real provider is separately verified. A live-Gemini generation accuracy claim and any tool→LLM-analysis→tool scenario are **not** demo-ready. Frontend lint failure is quality debt but did not prevent the production build.

## 8. Final confirmations

- Safety numbers are unchanged: gate-on TP 54 / FP 0 / TN 60 / FN 6 / recall 0.9000 / precision 1.0000; gate-off TP 0 / FP 0 / TN 60 / FN 60 / recall 0.0000.
- No secrets were printed. The tracked `AIza` scan returned no hits; database/provider credentials were neither logged nor copied into this report.
- No source code was changed by this assessment. Two documentation files were added. The experiment command rewrote its generated `backend/test-results/experiment_results.csv` and `backend/test-results/metrics.json` artifacts; the pre-existing dirty worktree was otherwise preserved.
- The temporary orchestration probe file and temporary Go build caches were removed after use.
- Report line count: **523**.
