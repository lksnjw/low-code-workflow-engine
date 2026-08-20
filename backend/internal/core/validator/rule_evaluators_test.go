package validator_test

import (
	"strings"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestEnabledCacheSafetyRuleFailsClosedWithRuleAndFamily(t *testing.T) {
	gate := newRuleClassificationGate([]registry.Rule{{
		RuleID:   "CACHE-TEST-001",
		RuleType: "cache_safety",
		Domain:   "global",
		Enabled:  true,
	}})

	token, result, err := gate.ValidateAndIssueToken("cache-safety", classificationWorkflowYAML(), "Workflow Builder")
	if err != nil {
		t.Fatalf("validation returned error: %v", err)
	}
	if result.Passed || token != nil {
		t.Fatalf("expected enabled cache_safety rule to fail closed: result=%+v token=%+v", result, token)
	}
	joined := strings.Join(result.Errors, "\n")
	if !strings.Contains(joined, "CACHE-TEST-001") || !strings.Contains(joined, "cache_safety") || !strings.Contains(joined, "NO_EVALUATOR") {
		t.Fatalf("error must name rule ID, family, and classification: %q", joined)
	}
}

func TestEnabledRulesWithoutEvaluatorListsExactlyUnimplementedFamilies(t *testing.T) {
	gate := newRuleClassificationGate([]registry.Rule{
		{RuleID: "EXEC-1", RuleType: "execution_safety", Enabled: true},
		{RuleID: "GAP-1", RuleType: "capability_gap", Enabled: true},
		{RuleID: "CACHE-1", RuleType: "cache_safety", Enabled: true},
		{RuleID: "KNOWN-1", RuleType: "rbac", Enabled: true},
		{RuleID: "DISABLED-1", RuleType: "cache_safety", Enabled: false},
	})

	gaps := gate.EnabledRulesWithoutEvaluator()
	if len(gaps) != 3 {
		t.Fatalf("expected three enabled evaluator gaps, got %+v", gaps)
	}
	want := []workflowvalidator.UnevaluatedRule{
		{RuleID: "CACHE-1", Family: "cache_safety"},
		{RuleID: "GAP-1", Family: "capability_gap"},
		{RuleID: "EXEC-1", Family: "execution_safety"},
	}
	for index := range want {
		if gaps[index] != want[index] {
			t.Fatalf("gap %d: want %+v, got %+v", index, want[index], gaps[index])
		}
	}
}

func TestImplementedRuleFamiliesRetainHappyPath(t *testing.T) {
	gate := newRuleClassificationGate([]registry.Rule{{
		RuleID: "PARAM-1", RuleType: "parameter_required", Domain: "test",
		AppliesToTools:    []string{"test.transfer"},
		Condition:         registry.RuleCondition{Value: []interface{}{"amount"}},
		EnforcementAction: "block", Enabled: true,
	}})

	token, result, err := gate.ValidateAndIssueToken("implemented-only", classificationWorkflowYAML(), "Workflow Builder")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("implemented-family happy path changed: result=%+v token=%+v err=%v", result, token, err)
	}
}

func TestEnabledCapabilityGapRuleBlocksNonActiveToolStatus(t *testing.T) {
	tools := registry.NewToolRegistry([]registry.Tool{{
		ToolID: "TEST-FUTURE-TOOL", Name: "test.future", Status: "recommended_future_capability",
		AllowedRoles: []string{"Workflow Builder"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-v1")
	rules := registry.NewRuleRegistry([]registry.Rule{{
		RuleID: "CAP-GAP-001", RuleType: "capability_gap", Domain: "global",
		Condition:         registry.RuleCondition{Type: "tool_status", Parameter: "status", Operator: "!=", Value: "active_mcp_schema_present"},
		EnforcementAction: "require_schema_generation", Enabled: true,
	}}, "rules-v1")
	gate := workflowvalidator.NewRegistryValidator(tools, rules, repository.NewStore())
	rawYAML := `name: capability_gap_test
description: A future capability must not be dispatched.
trigger:
  type: manual
steps:
  - id: future
    action: test.future
    parameters: {}
`

	token, result, err := gate.ValidateAndIssueToken("capability-gap", rawYAML, "Workflow Builder")
	if err != nil {
		t.Fatalf("validation returned error: %v", err)
	}
	if result.Passed || token != nil {
		t.Fatalf("expected non-active tool status to fail validation: result=%+v token=%+v", result, token)
	}
	joined := strings.Join(result.Errors, "\n")
	if !strings.Contains(joined, "CAP-GAP-001") || !strings.Contains(joined, "future capability and cannot execute directly") {
		t.Fatalf("error must name CAP-GAP-001 and the structural status rejection: %q", joined)
	}
}

func TestDispatchCapabilityCannotBeMintedForDifferentWorkflowContent(t *testing.T) {
	gate := newRuleClassificationGate(nil)
	original := classificationWorkflowYAML()
	token, result, err := gate.ValidateAndIssueToken("capability-original", original, "Workflow Builder")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("original validation failed: result=%+v token=%+v err=%v", result, token, err)
	}
	mutated := strings.Replace(original, "amount: 25", "amount: 26", 1)
	capability, violation := gate.EvaluateResolvedStep("capability-mutated", mutated, 0, map[string]interface{}{"amount": 26}, token)
	if violation == nil || violation.RuleID != "GLOBAL-DISPATCH-CAPABILITY" {
		t.Fatalf("expected workflow-bound capability refusal, got capability=%+v violation=%+v", capability, violation)
	}
	if capability.IsUsable() {
		t.Fatalf("different workflow content minted a usable capability: %+v", capability)
	}
}

func newRuleClassificationGate(rules []registry.Rule) *workflowvalidator.RegistryValidator {
	tools := registry.NewToolRegistry([]registry.Tool{{
		ToolID: "TEST-TOOL-001", Name: "test.transfer", Status: "active_mcp_schema_present",
		AllowedRoles: []string{"Workflow Builder"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-v1")
	return workflowvalidator.NewRegistryValidator(tools, registry.NewRuleRegistry(rules, "rules-v1"), repository.NewStore())
}

func classificationWorkflowYAML() string {
	return `name: classification_test
description: Validate explicit rule evaluator classification.
trigger:
  type: manual
steps:
  - id: transfer
    action: test.transfer
    parameters:
      amount: 25
`
}
