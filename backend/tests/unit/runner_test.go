package unit

import (
	"context"
	"errors"
	"testing"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

type spyPolicyTool struct {
	calls int
}

func (s *spyPolicyTool) Name() string        { return "test.transfer" }
func (s *spyPolicyTool) Description() string { return "records calls for policy tests" }
func (s *spyPolicyTool) Execute(_ context.Context, _ map[string]interface{}) (map[string]interface{}, error) {
	s.calls++
	return map[string]interface{}{"ok": true}, nil
}

func TestRunnerConstructorRejectsNilValidator(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected nil validator to panic at runner construction")
		}
	}()
	runner.NewExecutor(tools.NewRegistry(nil), nil, zap.NewNop())
}

func TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution(t *testing.T) {
	workflowYAML := thresholdWorkflowYAML("25")
	tests := []struct {
		name        string
		prepare     func(*workflowvalidator.RegistryValidator, models.Workflow) (*models.ValidationToken, models.Workflow)
		errorSubstr string
	}{
		{
			name: "nil token",
			prepare: func(_ *workflowvalidator.RegistryValidator, workflow models.Workflow) (*models.ValidationToken, models.Workflow) {
				return nil, workflow
			},
			errorSubstr: "validation token is required",
		},
		{
			name: "content hash mismatch",
			prepare: func(validator *workflowvalidator.RegistryValidator, workflow models.Workflow) (*models.ValidationToken, models.Workflow) {
				token, result, err := validator.ValidateAndIssueToken("test", workflow.YAML, "Workflow Builder")
				if err != nil || !result.Passed {
					t.Fatalf("plan validation failed: result=%+v err=%v", result, err)
				}
				workflow.YAML += "\n"
				return token, workflow
			},
			errorSubstr: "content hash mismatch",
		},
		{
			name: "forged token",
			prepare: func(validator *workflowvalidator.RegistryValidator, workflow models.Workflow) (*models.ValidationToken, models.Workflow) {
				return &models.ValidationToken{
					WorkflowContentHash: workflowvalidator.WorkflowContentHash(workflow.YAML),
					RegistryHash:        validator.RegistryHash(),
				}, workflow
			},
			errorSubstr: "token proof is invalid",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validator, executor, spy := newPolicyExecutor()
			workflow := models.Workflow{ID: "wf-token", Name: "Token test", YAML: workflowYAML}
			token, workflow := test.prepare(validator, workflow)
			_, err := executor.Run(context.Background(), "run-token", workflow, map[string]interface{}{}, token)
			if err == nil || !containsText(err.Error(), test.errorSubstr) {
				t.Fatalf("expected %q error, got %v", test.errorSubstr, err)
			}
			if spy.calls != 0 {
				t.Fatalf("expected zero tool calls, got %d", spy.calls)
			}
		})
	}
}

func TestLiteralOverThresholdRejectedAtPlanTime(t *testing.T) {
	validator, _, spy := newPolicyExecutor()
	token, result, err := validator.ValidateAndIssueToken("literal-plan", thresholdWorkflowYAML("101"), "Workflow Builder")
	if err != nil {
		t.Fatalf("validation returned error: %v", err)
	}
	if result.Passed || token != nil {
		t.Fatalf("expected literal over-threshold workflow to fail planning: %+v", result)
	}
	if spy.calls != 0 {
		t.Fatalf("planning must not execute tools, got %d calls", spy.calls)
	}
}

func TestDeferredThresholdDispatch(t *testing.T) {
	tests := []struct {
		name          string
		amount        interface{}
		wantViolation bool
		wantCalls     int
	}{
		{name: "under threshold executes", amount: 25, wantCalls: 1},
		{name: "over threshold aborts before tool", amount: 123456, wantViolation: true, wantCalls: 0},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validator, executor, spy := newPolicyExecutor()
			rawYAML := thresholdWorkflowYAML(`"{{input.amount}}"`)
			token, result, err := validator.ValidateAndIssueToken("deferred-plan", rawYAML, "Workflow Builder")
			if err != nil || !result.Passed || token == nil {
				t.Fatalf("expected deferred plan to pass: result=%+v token=%+v err=%v", result, token, err)
			}
			if !hasDeferredRule(token.DeferredChecks, "TEST-THRESH-001") {
				t.Fatalf("expected threshold deferral, got %+v", token.DeferredChecks)
			}

			workflow := models.Workflow{ID: "wf-deferred", Name: "Deferred", YAML: rawYAML}
			_, runErr := executor.Run(context.Background(), "run-deferred", workflow, map[string]interface{}{"amount": test.amount}, token)
			var policyErr *runner.ErrDispatchPolicyViolation
			if test.wantViolation {
				if !errors.As(runErr, &policyErr) {
					t.Fatalf("expected dispatch policy violation, got %v", runErr)
				}
				if policyErr.RuleID != "TEST-THRESH-001" || policyErr.ParamKey != "amount" {
					t.Fatalf("unexpected policy error: %+v", policyErr)
				}
				if policyErr.RedactedValue != "1234…" || containsText(policyErr.Error(), "123456") {
					t.Fatalf("offending value was not safely redacted: %+v", policyErr)
				}
			} else if runErr != nil {
				t.Fatalf("under-threshold execution failed: %v", runErr)
			}
			if spy.calls != test.wantCalls {
				t.Fatalf("expected %d tool calls, got %d", test.wantCalls, spy.calls)
			}
		})
	}
}

func TestBaselineBExecutesDispatchViolationAndAuditsBypass(t *testing.T) {
	validator, executor, spy := newPolicyExecutor()
	executor.SetBaselineB(true)
	rawYAML := thresholdWorkflowYAML(`"{{input.amount}}"`)
	token, result, err := validator.ValidateAndIssueToken("baseline-b-plan", rawYAML, "Workflow Builder")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("expected deferred plan to pass: result=%+v token=%+v err=%v", result, token, err)
	}

	workflow := models.Workflow{ID: "wf-baseline-b", Name: "Baseline B", YAML: rawYAML}
	_, runErr := executor.Run(context.Background(), "run-baseline-b", workflow, map[string]interface{}{"amount": 123456}, token)
	if runErr != nil {
		t.Fatalf("Baseline B should execute despite dispatch violation: %v", runErr)
	}
	if spy.calls != 1 {
		t.Fatalf("expected spy tool execution, got %d calls", spy.calls)
	}
	if !baselineAuditFound(validator.Store, "dispatch_revalidation", "TEST-THRESH-001") {
		t.Fatal("expected Baseline B dispatch bypass audit")
	}
}

func TestBaselineBBypassesMissingTokenWhileDefaultStillBlocks(t *testing.T) {
	workflow := models.Workflow{ID: "wf-token-comparison", Name: "Token comparison", YAML: thresholdWorkflowYAML("25")}

	_, gatedExecutor, gatedSpy := newPolicyExecutor()
	if _, err := gatedExecutor.Run(context.Background(), "run-gated", workflow, map[string]interface{}{}, nil); err == nil {
		t.Fatal("expected default mode to block a missing token")
	}
	if gatedSpy.calls != 0 {
		t.Fatalf("default mode executed %d tool calls", gatedSpy.calls)
	}

	validator, baselineExecutor, baselineSpy := newPolicyExecutor()
	baselineExecutor.SetBaselineB(true)
	if _, err := baselineExecutor.Run(context.Background(), "run-baseline-token", workflow, map[string]interface{}{}, nil); err != nil {
		t.Fatalf("Baseline B should bypass the missing token: %v", err)
	}
	if baselineSpy.calls != 1 {
		t.Fatalf("expected Baseline B spy execution, got %d calls", baselineSpy.calls)
	}
	if !baselineAuditFound(validator.Store, "validation_token_required", "") {
		t.Fatal("expected Baseline B token bypass audit")
	}
}

func TestResolvedSensitiveKeyAbortsBeforeTool(t *testing.T) {
	validator, executor, spy := newPolicyExecutor()
	rawYAML := thresholdWorkflowYAML(`"{{input.amount}}"`)
	token, result, err := validator.ValidateAndIssueToken("sensitive-plan", rawYAML, "Workflow Builder")
	if err != nil || !result.Passed {
		t.Fatalf("expected plan to pass: result=%+v err=%v", result, err)
	}
	workflow := models.Workflow{ID: "wf-sensitive", YAML: rawYAML}
	_, runErr := executor.Run(context.Background(), "run-sensitive", workflow, map[string]interface{}{
		"amount": map[string]interface{}{"api_key": "super-secret"},
	}, token)
	var policyErr *runner.ErrDispatchPolicyViolation
	if !errors.As(runErr, &policyErr) || policyErr.RuleID != "GLOBAL-SAFETY-002" {
		t.Fatalf("expected sensitive-key policy violation, got %v", runErr)
	}
	if spy.calls != 0 {
		t.Fatalf("expected no tool execution, got %d calls", spy.calls)
	}
}

func TestDeferredRequiredParameterRevalidatedAtDispatch(t *testing.T) {
	tests := []struct {
		name      string
		input     map[string]interface{}
		wantError bool
		wantCalls int
	}{
		{name: "resolved parameter executes", input: map[string]interface{}{"reference": "REF-25"}, wantCalls: 1},
		{name: "unresolved parameter aborts", input: map[string]interface{}{}, wantError: true, wantCalls: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validator, executor, spy := newPolicyExecutorWithRules([]coreregistry.Rule{{
				RuleID: "TEST-PARAM-001", RuleType: "parameter_required", Domain: "test",
				AppliesToTools: []string{"test.transfer"}, Condition: coreregistry.RuleCondition{Value: []interface{}{"reference"}},
				EnforcementAction: "block", Enabled: true,
			}})
			rawYAML := thresholdWorkflowYAMLWithReference()
			token, result, err := validator.ValidateAndIssueToken("parameter-plan", rawYAML, "Workflow Builder")
			if err != nil || !result.Passed || !hasDeferredRule(token.DeferredChecks, "TEST-PARAM-001") {
				t.Fatalf("expected deferred parameter plan: result=%+v token=%+v err=%v", result, token, err)
			}
			workflow := models.Workflow{ID: "wf-parameter", YAML: rawYAML}
			_, runErr := executor.Run(context.Background(), "run-parameter", workflow, test.input, token)
			var policyErr *runner.ErrDispatchPolicyViolation
			if test.wantError {
				if !errors.As(runErr, &policyErr) || policyErr.RuleID != "TEST-PARAM-001" {
					t.Fatalf("expected parameter policy violation, got %v", runErr)
				}
			} else if runErr != nil {
				t.Fatalf("resolved parameter execution failed: %v", runErr)
			}
			if spy.calls != test.wantCalls {
				t.Fatalf("expected %d tool calls, got %d", test.wantCalls, spy.calls)
			}
		})
	}
}

func TestDeferredCheckWithoutEvaluatorFailsClosed(t *testing.T) {
	validator, executor, spy := newPolicyExecutorWithRules([]coreregistry.Rule{{
		RuleID: "UNKNOWN-RULE", RuleType: "unsupported_sensitivity", Domain: "test",
		AppliesToTools: []string{"test.transfer"}, Condition: coreregistry.RuleCondition{Type: "sensitive_key"},
		EnforcementAction: "block", Enabled: true,
	}})
	rawYAML := thresholdWorkflowYAML(`"{{input.amount}}"`)
	token, result, err := validator.ValidateAndIssueToken("unknown-evaluator-plan", rawYAML, "Workflow Builder")
	if err != nil || !result.Passed {
		t.Fatalf("expected plan to pass: result=%+v err=%v", result, err)
	}
	if !hasDeferredRule(token.DeferredChecks, "UNKNOWN-RULE") {
		t.Fatalf("expected unsupported rule to be deferred, got %+v", token.DeferredChecks)
	}
	workflow := models.Workflow{ID: "wf-unknown-evaluator", YAML: rawYAML}
	_, runErr := executor.Run(context.Background(), "run-unknown-evaluator", workflow, map[string]interface{}{"amount": 25}, token)
	var policyErr *runner.ErrDispatchPolicyViolation
	if !errors.As(runErr, &policyErr) || policyErr.RuleID != "UNKNOWN-RULE" {
		t.Fatalf("expected fail-closed unknown evaluator error, got %v", runErr)
	}
	if spy.calls != 0 {
		t.Fatalf("expected no tool execution, got %d calls", spy.calls)
	}
}

func newPolicyExecutor() (*workflowvalidator.RegistryValidator, *runner.Executor, *spyPolicyTool) {
	return newPolicyExecutorWithRules(nil)
}

func newPolicyExecutorWithRules(extraRules []coreregistry.Rule) (*workflowvalidator.RegistryValidator, *runner.Executor, *spyPolicyTool) {
	toolDefinitions := coreregistry.NewToolRegistry([]coreregistry.Tool{{
		ToolID: "TEST-TOOL-001", Name: "test.transfer", Status: "active_mcp_schema_present",
		AllowedRoles: []string{"Workflow Builder"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-v1")
	ruleDefinitions := []coreregistry.Rule{
		{
			RuleID: "TEST-THRESH-001", RuleType: "amount_threshold", Domain: "test",
			AppliesToTools: []string{"test.transfer"}, Condition: coreregistry.RuleCondition{Parameter: "amount", Operator: ">", Value: 100},
			EnforcementAction: "require_human_approval", Enabled: true,
		},
		{
			RuleID: "GLOBAL-SAFETY-002", RuleType: "data_confidentiality", Domain: "global",
			Condition:         coreregistry.RuleCondition{Type: "sensitive_key", Parameter: "parameters", Operator: "not_exists"},
			EnforcementAction: "block", Enabled: true,
		},
	}
	ruleDefinitions = append(ruleDefinitions, extraRules...)
	rules := coreregistry.NewRuleRegistry(ruleDefinitions, "rules-v1")
	validator := workflowvalidator.NewRegistryValidator(toolDefinitions, rules, repository.NewStore())
	spy := &spyPolicyTool{}
	toolRegistry := tools.NewRegistry(nil)
	toolRegistry.Register(spy)
	return validator, runner.NewExecutor(toolRegistry, validator, zap.NewNop()), spy
}

func thresholdWorkflowYAML(amount string) string {
	return `name: threshold_test
description: Validate a transfer threshold at planning and dispatch.
trigger:
  type: manual
steps:
  - id: transfer
    action: test.transfer
    parameters:
      amount: ` + amount + "\n"
}

func thresholdWorkflowYAMLWithReference() string {
	return `name: parameter_test
description: Revalidate a required parameter after state resolution.
trigger:
  type: manual
steps:
  - id: transfer
    action: test.transfer
    parameters:
      amount: 25
      reference: "{{input.reference}}"
`
}

func hasDeferredRule(checks []models.DeferredCheck, ruleID string) bool {
	for _, check := range checks {
		for _, item := range check.RuleIDs {
			if item == ruleID {
				return true
			}
		}
	}
	return false
}

func containsText(value, needle string) bool {
	for index := 0; index+len(needle) <= len(value); index++ {
		if value[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}

func baselineAuditFound(store *repository.Store, decision, ruleID string) bool {
	store.Mu.RLock()
	defer store.Mu.RUnlock()
	for _, entry := range store.AuditLogs {
		if entry.After["baseline"] != "B" || entry.After["decision"] != decision || entry.After["would_have_blocked"] != true {
			continue
		}
		if ruleID == "" {
			return true
		}
		evidence, ok := entry.After["evidence"].(map[string]interface{})
		if ok && evidence["rule_id"] == ruleID {
			return true
		}
	}
	return false
}
