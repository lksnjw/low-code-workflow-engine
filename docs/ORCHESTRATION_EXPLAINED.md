# How step-to-step orchestration works

Here is how API-to-API data flow works in this system, step by step. The runner executes the YAML steps in list order. When step A succeeds, the complete JSON-object result from its registered tool is saved in runner state under step A's ID. Immediately before step B runs, every value in step B's parameters is recursively resolved against that state, so **{{step_a.field}}** becomes the corresponding value. The resolved parameters then pass through dispatch-time validation (G2), which re-evaluates checks that G1 deferred because their values were templates. Only after G2 allows the step does the runner call step B's tool. This is direct substitution and API-to-API passing; there is no runtime LLM-analysis or general transformation step.

## 1. Workflow shape

The current runtime model requires a workflow name, a trigger, and at least one step. Each step has a required **id** and **action** and an optional **parameters** map. The model has no dependency field and no declared-output field.

Evidence — **backend/internal/models/workflow.go:14-19,28-36**:

~~~go
type WorkflowBlueprint struct {
    Name        string
    Description string
    Trigger     BlueprintTrigger
    Steps       []WorkflowStepBlueprint
    Metadata    map[string]interface{}
}

type WorkflowStepBlueprint struct {
    ID          string
    Type        string
    Action      string
    Parameters  map[string]interface{}
    Condition   string
    OnError     string
    RetryCount  int
    Description string
}
~~~

The field names above are the Go field names; their source tags at the cited lines bind them to YAML **name**, **description**, **trigger**, **steps**, **id**, **type**, **action**, **parameters**, **condition**, **onError**, **retryCount**, and **description**.

A current executable test constructs this accepted two-step shape.

Evidence — **backend/cmd/mock-erp/service_test.go:203-209** (the Go string concatenation decoded as YAML):

~~~yaml
name: mock_erp_boundary
description: Proves a blocked second step never reaches the downstream service.
trigger:
  type: manual
steps:
  - id: first
    action: demo.echo
    parameters:
      message: hello
      amount: 1
  - id: blocked
    action: finance.clear_invoice
    parameters:
      invoice_id: INV-001
      amount: '{{input.amount}}'
~~~

That current test is multi-step, but its second step references workflow input, not the first step's output.

The repository's concrete step-output example is in **datasets/semantic_validation/batch_001.jsonl:16**. The relevant YAML embedded in that JSONL record is:

~~~yaml
steps:
  - step_id: step_1
    action: fetch_record
    parameters:
      table: leave_requests

  - step_id: step_2
    action: calculate_sum
    parameters:
      source_step: step_1
      field_name: amount
    depends_on: step_1

  - step_id: step_3
    action: check_condition
    parameters:
      condition: "{{step_2.total}} > 50000"
    depends_on: step_2

  - step_id: step_4
    action: send_email_notification
    parameters:
      body: "Total is {{step_2.total}} LKR and condition result is {{step_3.result}}."
    depends_on: step_3
~~~

Important qualification: this semantic-validation dataset uses legacy fields **step_id** and **depends_on**. It is not a current strict-runner fixture. The current decoder rejects unknown fields.

Evidence — **backend/internal/core/validator/registry_validator.go:971-977**:

~~~go
// ParseWorkflowYAMLStrict rejects unknown fields and multiple YAML documents.
func ParseWorkflowYAMLStrict(raw string) (models.WorkflowBlueprint, error) {
    var blueprint models.WorkflowBlueprint
    decoder := yaml.NewDecoder(strings.NewReader(parser.StripMarkdownFence(raw)))
    decoder.KnownFields(true)
    if err := decoder.Decode(&blueprint); err != nil {
        return blueprint, fmt.Errorf("parse workflow yaml: %w", err)
    }
~~~

A checked-in current-schema executable fixture that passes one step's output into another is therefore **MISSING**. Searches for a non-input template reference in current Go/YAML tests and runtime code found only **backend/docs/internal/core/runner/README.md:10**, which gives the syntax example **{{step_id.output}}**. Concrete A-to-B examples exist only in the legacy semantic dataset.

### Exact reference syntax

The state manager accepts an exact template whose path contains letters, digits, underscore, dot, or hyphen, with optional whitespace inside the braces. The normal field reference is:

~~~text
{{step_id.field}}
~~~

Nested map fields work:

~~~text
{{step_id.result.amount}}
~~~

Evidence — **backend/internal/core/runner/state_manager.go:35-41,59-72**:

~~~go
matches := exactVariablePattern.FindStringSubmatch(strings.TrimSpace(typed))
if len(matches) == 2 {
    if resolved, ok := lookupStatePath(state, matches[1]); ok {
        return resolved
    }
}
return parser.ResolveVariables(typed, state)

func lookupStatePath(state map[string]interface{}, path string) (interface{}, bool) {
    parts := strings.Split(path, ".")
    var current interface{} = state
    for _, part := range parts {
        asMap, ok := current.(map[string]interface{})
        if !ok {
            return nil, false
        }
        current, ok = asMap[part]
        if !ok {
            return nil, false
        }
    }
    return current, true
}
~~~

Steps run in YAML slice order, not from a dependency graph.

Evidence — **backend/internal/core/runner/executor.go:87-98**:

~~~go
for index, step := range blueprint.Steps {
    // timeline setup
    params := manager.Resolve(step.Parameters)
~~~

## 2. Four-stage trace: store output -> resolve reference -> revalidate -> call

### Stage 1 — Store step A's output

A tool returns a **map[string]interface{}**. A successful remote MCP response must decode as a JSON object and is returned as that map.

Evidence — **backend/internal/tools/tool_interface.go:5-8** and **backend/internal/tools/mcp_client.go:96-101**:

~~~go
type Tool interface {
    Name() string
    Description() string
    Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error)
}
~~~

~~~go
var payload map[string]interface{}
if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
    return nil, fmt.Errorf("decode mcp response: %w", err)
}
return payload, nil
~~~

After a successful call, the executor saves the returned map under the current step ID.

Evidence — **backend/internal/core/runner/executor.go:134-150** and **backend/internal/core/runner/state_manager.go:75-77**:

~~~go
toolResult, err := tool.Execute(ctx, params)
// failure handling
manager.Save(step.ID, toolResult)
~~~

~~~go
func (m *StateManager) Save(stepID string, result map[string]interface{}) {
    m.state.Variables[stepID] = result
}
~~~

The whole response map is stored; there is no declared-output selector and no filtering in Save. Step B can read any field present in step A's result map, including nested map fields. Limits:

- Lookup requires a map at every dot-separated segment, so array indexing is unsupported.
- A JSON key that cannot be expressed by the reference grammar is not addressable by this syntax.
- There is no output allow-list or output-schema validation.

### Stage 2 — Resolve every parameter of step B

Resolve iterates over every top-level parameter. Its helper recursively processes strings, lists, and nested maps. An exact reference returns the original Go value, so a number remains a number. A reference embedded in a larger string is converted to text.

Evidence — **backend/internal/core/runner/state_manager.go:24-55**:

~~~go
func (m *StateManager) Resolve(params map[string]interface{}) map[string]interface{} {
    out := make(map[string]interface{}, len(params))
    for key, value := range params {
        out[key] = resolveValue(value, m.state.Variables)
    }
    return out
}

func resolveValue(value interface{}, state map[string]interface{}) interface{} {
    switch typed := value.(type) {
    case string:
        matches := exactVariablePattern.FindStringSubmatch(strings.TrimSpace(typed))
        if len(matches) == 2 {
            if resolved, ok := lookupStatePath(state, matches[1]); ok {
                return resolved
            }
        }
        return parser.ResolveVariables(typed, state)
    case []interface{}:
        out := make([]interface{}, len(typed))
        for index, item := range typed {
            out[index] = resolveValue(item, state)
        }
        return out
    case map[string]interface{}:
        out := make(map[string]interface{}, len(typed))
        for key, item := range typed {
            out[key] = resolveValue(item, state)
        }
        return out
    default:
        return value
    }
}
~~~

Embedded references are string interpolation, not expression evaluation.

Evidence — **backend/pkg/parser/regex_util.go:32-39**:

~~~go
func resolveString(value string, state map[string]interface{}) string {
    return variablePattern.ReplaceAllStringFunc(value, func(match string) string {
        key := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(match, "{{"), "}}"))
        if resolved, ok := lookupPath(state, key); ok {
            return fmt.Sprint(resolved)
        }
        return match
    })
}
~~~

Resolution happens inside the step loop immediately before dispatch validation.

Evidence — **backend/internal/core/runner/executor.go:87-99**:

~~~go
for index, step := range blueprint.Steps {
    // timeline setup
    params := manager.Resolve(step.Parameters)
    if violation := e.Validator.EvaluateResolvedStep(
        "dispatch."+executionID, blueprint, index, params, token,
    ); violation != nil && e.baselineB {
~~~

### Stage 3 — Dispatch-time revalidation (G2)

At G1, a threshold parameter containing a template is recorded as a deferred check rather than guessed.

Evidence — **backend/internal/core/validator/registry_validator.go:296-314**:

~~~go
rawValue, exists := step.Parameters[param]
if !exists {
    continue
}
if containsUnresolvedTemplate(rawValue) {
    result.addDeferredCheck(stepIndex, param, rule.RuleID)
    continue
}
violated, evaluable, reason := evaluateThresholdValue(rule, blueprint, step, rawValue)
~~~

A successful G1 token carries those deferred checks into the runner.

Evidence — **backend/internal/core/validator/registry_validator.go:84-92**:

~~~go
var token *models.ValidationToken
if result.Passed {
    token = &models.ValidationToken{
        WorkflowContentHash: contentHash,
        RegistryHash:        registryHash,
        PassedAt:            time.Now().UTC(),
        DeferredChecks:      cloneDeferredChecks(result.DeferredChecks),
    }
    token.Proof = v.signToken(token)
}
~~~

At G2, only checks for the current step are evaluated against the already-resolved params. A missing/disabled rule or a rule without an evaluator fails closed.

Evidence — **backend/internal/core/validator/registry_validator.go:393-445**:

~~~go
// EvaluateResolvedStep runs the shared deterministic rule evaluators against
// values after state resolution and records the dispatch gate decision.
if violation == nil && token != nil {
    for _, deferred := range token.DeferredChecks {
        if deferred.StepIndex != stepIndex {
            continue
        }
        for _, ruleID := range deferred.RuleIDs {
            rule, ok := v.enabledRuleByID(ruleID)
            if !ok {
                violation = &ResolvedPolicyViolation{
                    StepIndex: stepIndex,
                    ParamKey:  deferred.ParamKey,
                    RuleID:    ruleID,
                    Value:     params[deferred.ParamKey],
                    Reason:    "deferred rule has no enabled evaluator",
                }
                break
            }
            failed, evaluable, reason := evaluateResolvedRule(
                rule, blueprint, blueprint.Steps[stepIndex], deferred.ParamKey, params,
            )
            if !evaluable || failed {
                violation = &ResolvedPolicyViolation{
                    StepIndex: stepIndex,
                    ParamKey:  deferred.ParamKey,
                    RuleID:    ruleID,
                    Value:     params[deferred.ParamKey],
                    Reason:    reason,
                }
                break
            }
        }
    }
}
~~~

For amount and quantity thresholds, G2 rejects unresolved or non-numeric values and otherwise applies the numeric threshold comparison.

Evidence — **backend/internal/core/validator/registry_validator.go:468-478,495-512**:

~~~go
case "amount_threshold", "quantity_threshold":
    value, ok := params[paramKey]
    if !ok || containsUnresolvedTemplate(value) {
        return true, true, message(rule, fmt.Sprintf(
            "Step %s parameter %s did not resolve to an evaluable value", step.ID, paramKey,
        ))
    }
    if _, ok := numeric(value); !ok {
        return true, true, message(rule, fmt.Sprintf(
            "Step %s parameter %s did not resolve to a numeric value", step.ID, paramKey,
        ))
    }
    return evaluateThresholdValue(rule, blueprint, step, value)
~~~

~~~go
threshold, thresholdOK := numeric(rule.Condition.Value)
value, valueOK := numeric(rawValue)
// operator validation
if !compareNumber(value, rule.Condition.Operator, threshold) {
    return false, true, ""
}
// require_human_approval or block enforcement follows
~~~

Thus, if step B's threshold-controlled parameter is **{{step_a.amount}}**, the path is:

1. G1 sees a template and stores the applicable rule in DeferredChecks.
2. Step A's result is saved under **step_a**.
3. Step B resolves **amount** from that result.
4. G2 compares the resolved number with the threshold.
5. An unsafe number produces ErrDispatchPolicyViolation before step B's tool call.

Evidence for the final block-before-call ordering — **backend/internal/core/runner/executor.go:98-134**:

~~~go
params := manager.Resolve(step.Parameters)
if violation := e.Validator.EvaluateResolvedStep(
    "dispatch."+executionID, blueprint, index, params, token,
); violation != nil && e.baselineB {
    // experiment-only gate-off bypass
} else if violation != nil {
    // record failed step and redacted policy evidence
    return result, policyErr
}
params["_action"] = step.Action
tool, err := e.Registry.Get(step.Action)
// ...
toolResult, err := tool.Execute(ctx, params)
~~~

The existing **TestDeferredThresholdDispatch** proves this G2 threshold block occurs before a tool call (**backend/tests/unit/runner_test.go:105-147**), but its template is **{{input.amount}}** at lines 119-129. The G2 implementation is source-agnostic because it receives the final resolved params map, but a current executable A-output-to-B-threshold integration test is **MISSING**.

Validation scope: G2 scans resolved parameters for sensitive keys and evaluates rules carried in token.DeferredChecks. It is not a general output-schema validator. G1 parameter validation checks required-parameter presence, not the eventual response field's existence or the complete input JSON schema.

Evidence — **backend/internal/core/validator/registry_validator.go:212-222**:

~~~go
func (v *RegistryValidator) validateRequiredParameters(tool registry.Tool, step models.WorkflowStepBlueprint, result *CandidateValidationResult) {
    if step.Parameters == nil {
        step.Parameters = map[string]interface{}{}
    }
    for _, param := range tool.RequiredParameters {
        value, ok := step.Parameters[param]
        if !ok || isEmptyValue(value) {
            result.ParametersOK = false
            result.addError("MISSING_PARAMETER", fmt.Sprintf(
                "Step %s using %s is missing required parameter %s", step.ID, tool.Name, param,
            ))
        }
    }
}
~~~

A missing **{{step_a.field}}** stays unresolved. G2 blocks it when a deferred required/threshold rule covers that parameter. Otherwise, there is no universal reference-existence check, so the unresolved template string can reach the downstream tool.

### Stage 4 — Call step B

Only after resolution and G2 does the runner add the validated action, look up the registered tool, and call it.

Evidence — **backend/internal/core/runner/executor.go:127-147**:

~~~go
params["_action"] = step.Action

tool, err := e.Registry.Get(step.Action)
if err != nil {
    return result, err
}

toolResult, err := tool.Execute(ctx, params)
// ...
if err != nil {
    // record failed step
    return result, fmt.Errorf("step %s failed: %w", step.ID, err)
}
~~~

The generic MCP bridge forwards the resolved map as request parameters.

Evidence — **backend/internal/tools/mcp_client.go:69-77,137-142**:

~~~go
body, err := json.Marshal(map[string]interface{}{
    "action":     action,
    "parameters": params,
})
// ...
req, err := http.NewRequestWithContext(
    ctx, http.MethodPost, c.BaseURL+"/tools/execute", bytes.NewReader(body),
)
~~~

~~~go
func (t GenericMCPTool) Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error) {
    action, _ := params["_action"].(string)
    if action == "" {
        action = t.Action
    }
    return t.Client.Execute(ctx, action, params)
}
~~~

Normal gate-on execution blocks at G2. Baseline B is an explicit experiment-only comparison path that audits and bypasses a violation (**backend/internal/core/runner/executor.go:49-53,99-108**); it is not normal gate-on behavior.

## 3. Failure and authorization handling between steps

Any error from step B stops the loop immediately. Step B is marked failed and no later step runs.

Evidence — **backend/internal/core/runner/executor.go:140-147**:

~~~go
if err != nil {
    timelineStep.Status = models.StatusFailed
    result.Timeline = append(result.Timeline, timelineStep)
    result.Logs = append(result.Logs, models.ExecutionLog{/* ... */})
    return result, fmt.Errorf("step %s failed: %w", step.ID, err)
}
~~~

The MCP client retains the downstream HTTP status in a typed error and deliberately discards the response body.

Evidence — **backend/internal/tools/mcp_client.go:28-36,89-93**:

~~~go
// MCPHTTPError preserves only the downstream HTTP status. Response bodies are
// deliberately discarded below because they may contain credentials or
// internal diagnostics.
type MCPHTTPError struct {
    StatusCode int
}

if resp.StatusCode >= 400 {
    // Downstream error bodies are untrusted and may contain credentials,
    // request parameters, or internal diagnostics. Never propagate them
    // into runner errors or logs.
    return nil, &MCPHTTPError{StatusCode: resp.StatusCode}
}
~~~

The execute handler explicitly classifies 400, 401, 404, and 5xx. Other HTTP statuses fail closed as terminal TOOL_FAILURE.

Evidence — **backend/internal/api/handlers/execute_handler.go:189-209**:

~~~go
var downstream *tools.MCPHTTPError
if errors.As(runErr, &downstream) {
    switch {
    case downstream.StatusCode == 400:
        failure.FailureCategory = models.FailureCategoryInvalidRequest
    case downstream.StatusCode == 401:
        failure.FailureCategory = models.FailureCategoryAuthDenied
    case downstream.StatusCode == 404:
        failure.FailureCategory = models.FailureCategoryNotFound
    case downstream.StatusCode >= 500 && downstream.StatusCode <= 599:
        failure.FailureCategory = models.FailureCategoryTransient
    default:
        // Unknown downstream statuses are terminal and retain TOOL_FAILURE.
    }
    return failure
}

if isTransientTransportFailure(runErr) {
    failure.FailureCategory = models.FailureCategoryTransient
}
~~~

Timeouts and network failures are separately recognized as transient.

Evidence — **backend/internal/api/handlers/execute_handler.go:212-221**:

~~~go
func isTransientTransportFailure(err error) bool {
    if errors.Is(err, context.DeadlineExceeded) {
        return true
    }
    var urlErr *url.Error
    if errors.As(err, &urlErr) {
        return true
    }
    var networkErr net.Error
    return errors.As(err, &networkErr)
}
~~~

Only TRANSIENT failures are eligible for healing.

Evidence — **backend/internal/api/handlers/execute_handler.go:96-100,126-130**:

~~~go
execution.Failure = h.classifyExecutionFailure(blueprint, runResult, err, failedStep, failedTool)
attachStepFailure(runResult.Timeline, execution.Failure)
if execution.Failure != nil &&
    execution.Failure.FailureCategory == models.FailureCategoryTransient &&
    h.Healer != nil {
    execution.Status = models.StatusHealing
    // healing attempt
    execution.Status = models.StatusFailed
} else if !errors.As(err, &policyViolation) {
    // HEALING_NOT_ATTEMPTED
}
~~~

Exact outcomes:

- **401:** AUTH_DENIED, terminal, not healed; the workflow stops.
- **403:** terminal and not healed, but **not** classified as AUTH_DENIED. It falls through to generic TOOL_FAILURE. This is the remaining Part C classification gap.
- **Timeout, connection error, or 5xx:** TRANSIENT; healing may be attempted when a healer is available.
- The run endpoint returns HTTP 422 for a failed workflow instead of relaying the downstream 401/403 (**backend/internal/api/handlers/execute_handler.go:144-146**).

## 4. SUPPORTED TODAY vs. NOT SUPPORTED (gap)

### SUPPORTED TODAY

- Sequential registered-tool/API execution in YAML list order.
- Whole JSON-object output storage under the producing step's ID.
- Exact typed references such as **{{step_a.amount}}**.
- String interpolation such as **Amount is {{step_a.amount}}**.
- Recursive resolution inside nested maps and lists.
- Nested output-map access using dot-separated keys.
- G1 deferral and G2 revalidation for template-dependent required, threshold, and sensitivity rules.
- Block-before-call behavior for G2 policy violations.
- Immediate workflow stop when a downstream step fails.
- 401 AUTH_DENIED and timeout/5xx TRANSIENT distinction.

### NOT SUPPORTED (gap)

- **MISSING — API -> LLM analyse/filter/summarise -> later step (Part D).** There is no llm, analysis, or transform step kind in the runner, validator, handlers, commands, tests, or runtime tool registry. These searches returned no matches:

  ~~~text
  rg -n -i 'llm[ _-]?step|analysis[ _-]?step|analyse[ _-]?step|analyze[ _-]?step|transform[ _-]?step|step[ _-]?(kind|type).*(llm|analysis|transform)' backend/internal backend/cmd backend/tests --glob '*.go'
  rg -n -i '^[[:space:]]*\x22(name|mcp_tool_name|type)\x22[[:space:]]*:[[:space:]]*\x22[^\x22]*(llm|analysis|analy[sz]|summari[sz]|transform|filter)[^\x22]*\x22' backend/configs/runtime/all_tools_master_registry.json
  ~~~

  LLM clients exist under **backend/internal/core/synthesizer**, but they generate workflow YAML before execution. The executor never invokes the synthesizer. The only executor use of step.Type is label construction.

  Evidence — **backend/internal/core/runner/executor.go:192-199**:

  ~~~go
  func labelForStep(step models.WorkflowStepBlueprint) string {
      if step.Description != "" {
          return step.Description
      }
      if step.Type != "" {
          return step.Type + ": " + step.Action
      }
      return step.Action
  }
  ~~~

- **MISSING — in-runner transformations.** The state manager only performs lookup and substitution. It does not evaluate arithmetic, boolean expressions, filters, mappings, summaries, or scripts. For example, **{{step_2.total}} > 50000** becomes a string such as **60000 > 50000**; the runner does not evaluate it. A registered downstream tool may process that string, but that is an ordinary external tool/API call, not an in-workflow transform facility.
- **MISSING — declared output contracts.** The workflow model has no outputs field; the whole returned map is stored.
- **MISSING — array-index reference navigation.** Lookup traverses only maps.
- **MISSING — universal unresolved-reference rejection.** Deferred-rule parameters fail closed, but arbitrary unresolved references are not universally rejected.
- **MISSING — semantic classification of downstream 403 (Part C).** A 403 is terminal but remains TOOL_FAILURE; only 401 maps to AUTH_DENIED.
- **MISSING — current executable A-output-to-B-input test.** Current tests cover multi-step execution and deferred workflow input, while concrete prior-step references exist only in the legacy semantic dataset.

## Bottom line

The implemented value path is: step A toolResult -> RunnerState.Variables[step A ID] -> recursive resolution of step B's parameters -> G2 evaluation of sensitive keys and token-carried deferred rules -> step B's registered tool call. This supports deterministic direct API-to-API passing. It does not provide a runtime LLM-processing step, a transformation language, declared output schemas, or an AUTH_DENIED category for downstream 403 responses.
