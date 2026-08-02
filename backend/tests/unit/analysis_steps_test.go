package unit

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/analysisprovider"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

type analysisSpyProvider struct {
	responses []analysisprovider.Response
	calls     int
	prompts   []string
	model     string
}

func (s *analysisSpyProvider) GenerateAnalysis(_ context.Context, prompt, _ string) (analysisprovider.Response, error) {
	s.calls++
	s.prompts = append(s.prompts, prompt)
	if len(s.responses) == 0 {
		return analysisprovider.Response{}, fmt.Errorf("no spy response")
	}
	index := s.calls - 1
	if index >= len(s.responses) {
		index = len(s.responses) - 1
	}
	return s.responses[index], nil
}

func (s *analysisSpyProvider) AnalysisModel() string { return s.model }

type namedSpyTool struct {
	name     string
	result   map[string]interface{}
	calls    int
	received []map[string]interface{}
}

func (s *namedSpyTool) Name() string        { return s.name }
func (s *namedSpyTool) Description() string { return "analysis step spy tool" }
func (s *namedSpyTool) Execute(_ context.Context, params map[string]interface{}) (map[string]interface{}, error) {
	s.calls++
	s.received = append(s.received, params)
	return s.result, nil
}

func TestAnalysisStepRunsFetchFilterActEndToEnd(t *testing.T) {
	validator, executor, fetch, act, provider := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	provider.responses = []analysisprovider.Response{{Text: `[{"invoice_id":"INV-2","amount":90,"days_overdue":45}]`, Model: "spy-model", Measured: true}}
	rawYAML := analysisWorkflowYAML(0, 0)
	token := requireAnalysisPlan(t, validator, rawYAML)

	result, err := executor.Run(context.Background(), "run-analysis", models.Workflow{ID: "wf-analysis", Name: "Invoice filter", YAML: rawYAML}, nil, token)
	if err != nil {
		t.Fatalf("analysis workflow failed: %v", err)
	}
	if fetch.calls != 1 || provider.calls != 1 || act.calls != 1 {
		t.Fatalf("unexpected call counts fetch=%d provider=%d act=%d", fetch.calls, provider.calls, act.calls)
	}
	if len(act.received) != 1 {
		t.Fatalf("final tool received no parameters")
	}
	invoices, ok := act.received[0]["invoices"].([]interface{})
	if !ok || len(invoices) != 1 || invoices[0].(map[string]interface{})["invoice_id"] != "INV-2" {
		t.Fatalf("final tool did not receive filtered output: %#v", act.received[0]["invoices"])
	}
	if len(result.Timeline) != 3 || result.Timeline[1].SideEffect == nil || *result.Timeline[1].SideEffect {
		t.Fatalf("analysis step was not recorded as sideEffect=false: %+v", result.Timeline)
	}
	if strings.Contains(provider.prompts[0], "Invoice filter") || strings.Contains(provider.prompts[0], "wf-analysis") {
		t.Fatalf("provider prompt included workflow state or metadata: %s", provider.prompts[0])
	}
}

func TestAnalysisStepRequiresOutputSchemaAtPlanTime(t *testing.T) {
	validator, _, _, _, _ := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	rawYAML := strings.Replace(analysisWorkflowYAML(0, 0), analysisSchemaYAML(), "", 1)
	token, result, err := validator.ValidateAndIssueToken("missing-schema", rawYAML, "Workflow Builder")
	if err != nil {
		t.Fatalf("validation returned error: %v", err)
	}
	if result.Passed || token != nil || !errorsContain(result.Errors, "ANALYSIS_OUTPUT_SCHEMA_INVALID") {
		t.Fatalf("analysis without output_schema was not rejected: %+v", result)
	}
}

func TestAnalysisStepRejectsUndeclaredInputSourceAtPlanTime(t *testing.T) {
	validator, _, _, _, _ := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	rawYAML := strings.Replace(analysisWorkflowYAML(0, 0), "{{fetch.output}}", "{{missing.output}}", 1)
	token, result, err := validator.ValidateAndIssueToken("missing-source", rawYAML, "Workflow Builder")
	if err != nil {
		t.Fatalf("validation returned error: %v", err)
	}
	if result.Passed || token != nil || !errorsContain(result.Errors, "ANALYSIS_INPUT_SOURCE_UNDECLARED") {
		t.Fatalf("analysis with undeclared source was not rejected: %+v", result)
	}
}

func TestAnalysisDataEgressViolationDoesNotCallProviderAndIsAudited(t *testing.T) {
	validator, executor, fetch, act, provider := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	fetch.result = map[string]interface{}{"output": []interface{}{map[string]interface{}{"invoice_id": "INV-1", "salary": "987654"}}}
	rawYAML := analysisWorkflowYAML(0, 0)
	token := requireAnalysisPlan(t, validator, rawYAML)

	result, runErr := executor.Run(context.Background(), "run-egress-block", models.Workflow{ID: "wf-egress", YAML: rawYAML}, nil, token)
	var egressErr *runner.ErrDataEgressViolation
	if !errors.As(runErr, &egressErr) || egressErr.RuleID != "TEST-DATA-001" {
		t.Fatalf("expected data-egress violation, got %v", runErr)
	}
	if egressErr.RedactedValue != "9876…" || strings.Contains(egressErr.Error(), "987654") {
		t.Fatalf("egress value was not bounded to first four characters: %+v", egressErr)
	}
	if fetch.calls != 1 || provider.calls != 0 || act.calls != 0 {
		t.Fatalf("blocked egress dispatch counts fetch=%d provider=%d act=%d", fetch.calls, provider.calls, act.calls)
	}
	if len(result.Timeline) != 2 || result.Timeline[1].Status != models.StatusFailed {
		t.Fatalf("blocked analysis was not terminal FAILED: %+v", result.Timeline)
	}
	if !analysisRuleAuditFound(validator.Store, "TEST-DATA-001") {
		t.Fatal("data-egress audit entry does not name TEST-DATA-001")
	}
}

func TestAnalysisConfidentialityRuleWithoutEvaluatorFailsClosed(t *testing.T) {
	validRule := dataConfidentialityRule()
	validator, executor, _, _, provider := newAnalysisExecutor([]coreregistry.Rule{validRule})
	rawYAML := analysisWorkflowYAML(0, 0)
	token := requireAnalysisPlan(t, validator, rawYAML)
	malformed := validRule
	malformed.Condition.Operator = ""
	validator.Rules.ReplaceAll([]coreregistry.Rule{malformed}, "rules-v1")

	_, runErr := executor.Run(context.Background(), "run-no-evaluator", models.Workflow{ID: "wf-no-evaluator", YAML: rawYAML}, nil, token)
	var egressErr *runner.ErrDataEgressViolation
	if !errors.As(runErr, &egressErr) || egressErr.RuleID != validRule.RuleID {
		t.Fatalf("expected fail-closed data-egress violation, got %v", runErr)
	}
	if provider.calls != 0 {
		t.Fatalf("provider called %d times despite missing evaluator", provider.calls)
	}
}

func TestAnalysisStepRejectsOversizedInputWithoutTruncation(t *testing.T) {
	tests := []struct {
		name       string
		fetchValue interface{}
		maxItems   int
		maxChars   int
	}{
		{name: "items", fetchValue: []interface{}{1, 2, 3}, maxItems: 2},
		{name: "characters", fetchValue: "payload-too-long", maxChars: 5},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validator, executor, fetch, _, provider := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
			fetch.result = map[string]interface{}{"output": test.fetchValue}
			rawYAML := analysisWorkflowYAML(test.maxItems, test.maxChars)
			token := requireAnalysisPlan(t, validator, rawYAML)
			_, runErr := executor.Run(context.Background(), "run-oversized", models.Workflow{ID: "wf-oversized", YAML: rawYAML}, nil, token)
			if runErr == nil || !strings.Contains(runErr.Error(), "input too large for analysis step") {
				t.Fatalf("expected explicit oversized-input rejection, got %v", runErr)
			}
			if provider.calls != 0 {
				t.Fatalf("provider received truncated input instead of rejection; calls=%d", provider.calls)
			}
		})
	}
}

func TestAnalysisMalformedModelOutputRetriesOnceThenFails(t *testing.T) {
	validator, executor, _, _, provider := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	provider.responses = []analysisprovider.Response{{Text: `not-json`}, {Text: `{"wrong":true}`}}
	rawYAML := analysisWorkflowYAML(0, 0)
	token := requireAnalysisPlan(t, validator, rawYAML)

	result, runErr := executor.Run(context.Background(), "run-malformed", models.Workflow{ID: "wf-malformed", YAML: rawYAML}, nil, token)
	if runErr == nil || !strings.Contains(runErr.Error(), "failed schema validation after one retry") {
		t.Fatalf("expected clean schema failure, got %v", runErr)
	}
	if provider.calls != 2 {
		t.Fatalf("expected exactly one corrective retry (2 calls total), got %d", provider.calls)
	}
	if len(result.Timeline) != 2 || result.Timeline[1].Status != models.StatusFailed {
		t.Fatalf("malformed output did not terminate FAILED: %+v", result.Timeline)
	}
}

func TestAnalysisRecordsMeasuredProviderTokenUsage(t *testing.T) {
	validator, executor, _, _, provider := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	provider.responses = []analysisprovider.Response{{Text: `[{"invoice_id":"INV-2","amount":90,"days_overdue":45}]`, InputTokens: 37, OutputTokens: 11, Measured: true}}
	rawYAML := analysisWorkflowYAML(0, 0)
	token := requireAnalysisPlan(t, validator, rawYAML)

	result, err := executor.Run(context.Background(), "run-usage", models.Workflow{ID: "wf-usage", YAML: rawYAML}, nil, token)
	if err != nil {
		t.Fatalf("analysis execution failed: %v", err)
	}
	if result.Tokens.Input != 37 || result.Tokens.Output != 11 || result.Tokens.Total != 48 {
		t.Fatalf("recorded tokens do not equal measured provider usage: %+v", result.Tokens)
	}
}

func TestAnalysisCachesIdenticalPayloadWithinExecution(t *testing.T) {
	validator, executor, _, _, provider := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	provider.responses = []analysisprovider.Response{{Text: `[{"invoice_id":"INV-2","amount":90,"days_overdue":45}]`, InputTokens: 5, OutputTokens: 2, Measured: true}}
	rawYAML := strings.Replace(analysisWorkflowYAML(0, 0), "  - id: act", `  - kind: analysis
    id: filter_again
    instruction: Return only overdue invoices.
    input: "{{fetch.output}}"
`+analysisSchemaYAML()+`  - id: act`, 1)
	token := requireAnalysisPlan(t, validator, rawYAML)

	result, err := executor.Run(context.Background(), "run-cache", models.Workflow{ID: "wf-cache", YAML: rawYAML}, nil, token)
	if err != nil {
		t.Fatalf("cached analysis workflow failed: %v", err)
	}
	if provider.calls != 1 {
		t.Fatalf("identical payload was sent %d times", provider.calls)
	}
	if result.Tokens.Total != 7 {
		t.Fatalf("cached result counted provider usage twice: %+v", result.Tokens)
	}
}

func TestToolOnlyWorkflowBehaviorUnchanged(t *testing.T) {
	validator, executor, fetch, act, provider := newAnalysisExecutor([]coreregistry.Rule{dataConfidentialityRule()})
	rawYAML := `name: tool_only
description: Existing tool-only execution path.
trigger:
  type: manual
steps:
  - id: fetch
    action: test.fetch
    parameters:
      request_id: REF-1
  - id: act
    action: test.act
    parameters:
      invoices: "{{fetch.output}}"
`
	token := requireAnalysisPlan(t, validator, rawYAML)
	result, err := executor.Run(context.Background(), "run-tool-only", models.Workflow{ID: "wf-tool-only", YAML: rawYAML}, nil, token)
	if err != nil {
		t.Fatalf("tool-only execution changed: %v", err)
	}
	if fetch.calls != 1 || act.calls != 1 || provider.calls != 0 {
		t.Fatalf("tool-only call path changed fetch=%d act=%d provider=%d", fetch.calls, act.calls, provider.calls)
	}
	if len(result.Timeline) != 2 || result.Timeline[0].SideEffect != nil || result.Timeline[1].SideEffect != nil {
		t.Fatalf("tool timeline representation changed: %+v", result.Timeline)
	}
	if act.received[0]["_action"] != "test.act" {
		t.Fatalf("tool _action dispatch parameter changed: %#v", act.received[0])
	}
}

func newAnalysisExecutor(rules []coreregistry.Rule) (*workflowvalidator.RegistryValidator, *runner.Executor, *namedSpyTool, *namedSpyTool, *analysisSpyProvider) {
	toolsDefinition := coreregistry.NewToolRegistry([]coreregistry.Tool{
		{ToolID: "FETCH", Name: "test.fetch", Status: "active_mcp_schema_present", RequiredParameters: []string{"request_id"}, AllowedRoles: []string{"Workflow Builder"}, RiskLevel: "low", IsReadOnly: true},
		{ToolID: "ACT", Name: "test.act", Status: "active_mcp_schema_present", RequiredParameters: []string{"invoices"}, AllowedRoles: []string{"Workflow Builder"}, RiskLevel: "low", IsReadOnly: true},
	}, "tools-v1")
	ruleDefinition := coreregistry.NewRuleRegistry(rules, "rules-v1")
	validator := workflowvalidator.NewRegistryValidator(toolsDefinition, ruleDefinition, repository.NewStore())
	fetch := &namedSpyTool{name: "test.fetch", result: map[string]interface{}{"output": []interface{}{
		map[string]interface{}{"invoice_id": "INV-1", "amount": 50, "days_overdue": 10},
		map[string]interface{}{"invoice_id": "INV-2", "amount": 90, "days_overdue": 45},
	}}}
	act := &namedSpyTool{name: "test.act", result: map[string]interface{}{"accepted": true}}
	toolRegistry := tools.NewRegistry(nil)
	toolRegistry.Register(fetch)
	toolRegistry.Register(act)
	executor := runner.NewExecutor(toolRegistry, validator, zap.NewNop())
	provider := &analysisSpyProvider{model: "spy-model"}
	executor.SetAnalysisProvider(provider)
	return validator, executor, fetch, act, provider
}

func dataConfidentialityRule() coreregistry.Rule {
	return coreregistry.Rule{
		RuleID: "TEST-DATA-001", RuleType: "data_confidentiality", Domain: "global",
		Condition:         coreregistry.RuleCondition{Type: "sensitive_key", Parameter: "input", Operator: "not_exists", Value: []interface{}{"salary", "national_id", "card_number", "credential", "password"}},
		EnforcementAction: "block", ValidatorMessage: "Confidential data cannot leave to a model provider.", Enabled: true,
	}
}

func analysisWorkflowYAML(maxItems, maxChars int) string {
	limits := ""
	if maxItems > 0 {
		limits += fmt.Sprintf("    max_input_items: %d\n", maxItems)
	}
	if maxChars > 0 {
		limits += fmt.Sprintf("    max_input_chars: %d\n", maxChars)
	}
	return `name: analysis_invoice_filter
description: Fetch invoices, filter them through structured analysis, and act.
trigger:
  type: manual
steps:
  - id: fetch
    action: test.fetch
    parameters:
      request_id: REF-1
  - kind: analysis
    id: filter
    instruction: Return only overdue invoices.
    input: "{{fetch.output}}"
` + analysisSchemaYAML() + limits + `  - id: act
    action: test.act
    parameters:
      invoices: "{{filter.output}}"
`
}

func analysisSchemaYAML() string {
	return `    output_schema:
      type: array
      items:
        type: object
        required: [invoice_id, amount, days_overdue]
        properties:
          invoice_id: {type: string}
          amount: {type: number}
          days_overdue: {type: integer}
`
}

func requireAnalysisPlan(t *testing.T, validator *workflowvalidator.RegistryValidator, rawYAML string) *models.ValidationToken {
	t.Helper()
	token, result, err := validator.ValidateAndIssueToken("analysis-plan", rawYAML, "Workflow Builder")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("analysis plan did not pass: result=%+v token=%+v err=%v", result, token, err)
	}
	return token
}

func errorsContain(items []string, substring string) bool {
	for _, item := range items {
		if strings.Contains(item, substring) {
			return true
		}
	}
	return false
}

func analysisRuleAuditFound(store *repository.Store, ruleID string) bool {
	store.Mu.RLock()
	defer store.Mu.RUnlock()
	for _, entry := range store.AuditLogs {
		ruleResults, ok := entry.After["rule_results"].(map[string]interface{})
		if ok && ruleResults["failed_rule"] == ruleID {
			return true
		}
	}
	return false
}
