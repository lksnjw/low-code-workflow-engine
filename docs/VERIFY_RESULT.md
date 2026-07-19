# G1/G2 Verification Result

Date: 2026-07-20  
Branch: `feat/experiment-readiness`

## Verdict

- **G1 — PASS.** `Executor.Run` rejects a missing token, an invalid proof, a workflow-content hash mismatch, and a registry hash mismatch before parsing or executing any workflow step.
- **G2 — PASS.** Each step's resolved parameters are passed to `EvaluateResolvedStep` before the tool is retrieved and before `Tool.Execute` is called. A violation is returned as `ErrDispatchPolicyViolation` and the tool is not executed.

No production code was changed during this verification. This report is the only Part 1 edit.

## Build

Environment used for the Windows workspace:

```powershell
$env:GOCACHE=(Resolve-Path '.gocache').Path
$env:GOMODCACHE=(Resolve-Path '.gomodcache').Path
$env:GOFLAGS='-buildvcs=false'
go build ./...
```

Exact output:

```text
<no output>
Exit code: 0
Wall time: 20.7 seconds
```

## Full test suite

```powershell
go test ./... -count=1
```

Exact output (the complete command output was shorter than 40 lines):

```text
?   	github.com/sanjeewa/agentic-orchestrator/cmd/server	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/internal/api/handlers	1.822s
?   	github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/api/routes	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/config	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/healing	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator	0.919s
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/registry	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/runner	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/validator	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/models	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/repository	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/tools	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/tools/impl	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/pkg/logger	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/pkg/parser	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/tests/integration	2.275s
?   	github.com/sanjeewa/agentic-orchestrator/tests/mocks	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/tests/unit	78.175s
Exit code: 0
Wall time: 85.2 seconds
```

## Required tests exist

```powershell
rg -n "TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution|TestDeferredThresholdDispatch|TestResolvedSensitiveKeyAbortsBeforeTool|TestDispatchViolationMarksExecutionFailedWithoutHealing|TestDeferredCheckWithoutEvaluatorFailsClosed" backend
```

Exact output:

```text
backend\internal\api\handlers\gate_invariant_test.go:172:func TestDispatchViolationMarksExecutionFailedWithoutHealing(t *testing.T) {
backend\tests\unit\runner_test.go:37:func TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution(t *testing.T) {
backend\tests\unit\runner_test.go:105:func TestDeferredThresholdDispatch(t *testing.T) {
backend\tests\unit\runner_test.go:151:func TestResolvedSensitiveKeyAbortsBeforeTool(t *testing.T) {
backend\tests\unit\runner_test.go:210:func TestDeferredCheckWithoutEvaluatorFailsClosed(t *testing.T) {
```

## Targeted gate tests

```powershell
go test ./... -run 'Dispatch|Deferred|Runner|Threshold' -v -count=1
```

Exact output (last 60 lines):

```text
?   	github.com/sanjeewa/agentic-orchestrator/cmd/server	[no test files]
=== RUN   TestDispatchViolationMarksExecutionFailedWithoutHealing
--- PASS: TestDispatchViolationMarksExecutionFailedWithoutHealing (0.00s)
PASS
ok  	github.com/sanjeewa/agentic-orchestrator/internal/api/handlers	1.714s
?   	github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/api/routes	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/config	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/healing	[no test files]
testing: warning: no tests to run
PASS
ok  	github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator	0.870s [no tests to run]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/registry	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/runner	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/validator	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/models	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/repository	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/tools	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/tools/impl	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/pkg/logger	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/pkg/parser	[no test files]
testing: warning: no tests to run
PASS
ok  	github.com/sanjeewa/agentic-orchestrator/tests/integration	1.924s [no tests to run]
?   	github.com/sanjeewa/agentic-orchestrator/tests/mocks	[no test files]
=== RUN   TestRunnerConstructorRejectsNilValidator
--- PASS: TestRunnerConstructorRejectsNilValidator (0.00s)
=== RUN   TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution
=== RUN   TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution/nil_token
=== RUN   TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution/content_hash_mismatch
=== RUN   TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution/forged_token
--- PASS: TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution (0.00s)
    --- PASS: TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution/nil_token (0.00s)
    --- PASS: TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution/content_hash_mismatch (0.00s)
    --- PASS: TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution/forged_token (0.00s)
=== RUN   TestLiteralOverThresholdRejectedAtPlanTime
--- PASS: TestLiteralOverThresholdRejectedAtPlanTime (0.00s)
=== RUN   TestDeferredThresholdDispatch
=== RUN   TestDeferredThresholdDispatch/under_threshold_executes
=== RUN   TestDeferredThresholdDispatch/over_threshold_aborts_before_tool
--- PASS: TestDeferredThresholdDispatch (0.00s)
    --- PASS: TestDeferredThresholdDispatch/under_threshold_executes (0.00s)
    --- PASS: TestDeferredThresholdDispatch/over_threshold_aborts_before_tool (0.00s)
=== RUN   TestDeferredRequiredParameterRevalidatedAtDispatch
=== RUN   TestDeferredRequiredParameterRevalidatedAtDispatch/resolved_parameter_executes
=== RUN   TestDeferredRequiredParameterRevalidatedAtDispatch/unresolved_parameter_aborts
--- PASS: TestDeferredRequiredParameterRevalidatedAtDispatch (0.00s)
    --- PASS: TestDeferredRequiredParameterRevalidatedAtDispatch/resolved_parameter_executes (0.00s)
    --- PASS: TestDeferredRequiredParameterRevalidatedAtDispatch/unresolved_parameter_aborts (0.00s)
=== RUN   TestDeferredCheckWithoutEvaluatorFailsClosed
--- PASS: TestDeferredCheckWithoutEvaluatorFailsClosed (0.00s)
PASS
ok  	github.com/sanjeewa/agentic-orchestrator/tests/unit	1.604s
Exit code: 0
Wall time: 4.9 seconds
```

## Adversarial greps

### Optional validator bypass

```powershell
rg -n "RegistryValidator == nil|RegistryValidator != nil" backend/internal -g '*.go'
```

Exact output:

```text
backend/internal\api\handlers\dashboard_handler.go:114:		healthService("Policy Gate", h.RegistryValidator != nil, "registry validation required", now),
```

Investigation: this is display-only health reporting. It does not guard validation, execution, or dispatch. `NewExecutor` panics on a nil validator, so the hit is not a bypass.

### Suspicious hard-coded metrics/values

```powershell
rg -n "duplicateWritesPrevented|1210|830|5400|3000" backend/internal -g '*.go'
```

Exact output:

```text
<no matches>
```

## Exact proof lines in `executor.go`

G1 proof (`Executor.Run` entry):

```text
48: func (e *Executor) Run(... token *models.ValidationToken) (Result, error) {
49:     if token == nil {
50:         return Result{}, fmt.Errorf("validation token is required")
52:     if !e.Validator.VerifyToken(token) {
53:         return Result{}, fmt.Errorf("validation token proof is invalid")
55:     if actual := workflowvalidator.WorkflowContentHash(workflow.YAML); actual != token.WorkflowContentHash {
56:         return Result{}, fmt.Errorf("validation token workflow content hash mismatch")
58:     if actual := e.Validator.RegistryHash(); actual != token.RegistryHash {
59:         return Result{}, fmt.Errorf("validation token registry hash mismatch")
```

G2 proof (resolved-value gate precedes tool retrieval and execution):

```text
93:     params := manager.Resolve(step.Parameters)
94:     if violation := e.Validator.EvaluateResolvedStep(..., params, token); violation != nil {
111:        return result, policyErr
115:    tool, err := e.Registry.Get(step.Action)
120:    toolResult, err := tool.Execute(ctx, params)
```

The call order is therefore: resolve values, evaluate dispatch policy, return on violation, retrieve tool, execute tool.
