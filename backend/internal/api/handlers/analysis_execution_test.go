package handlers

import (
	"context"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/analysisprovider"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

type handlerAnalysisProviderSpy struct{ calls int }

func (s *handlerAnalysisProviderSpy) GenerateAnalysis(context.Context, string, string) (analysisprovider.Response, error) {
	s.calls++
	return analysisprovider.Response{Text: `[]`}, nil
}
func (s *handlerAnalysisProviderSpy) AnalysisModel() string { return "spy-model" }

type handlerAnalysisFetchTool struct{ calls int }

func (s *handlerAnalysisFetchTool) Name() string        { return "test.analysis_fetch" }
func (s *handlerAnalysisFetchTool) Description() string { return "returns confidential test data" }
func (s *handlerAnalysisFetchTool) Execute(context.Context, workflowvalidator.DispatchCapability, map[string]interface{}) (map[string]interface{}, error) {
	s.calls++
	return map[string]interface{}{"output": []interface{}{map[string]interface{}{"salary": "987654"}}}, nil
}

func TestAnalysisDataEgressViolationIsFailedAndNeverHealed(t *testing.T) {
	toolDefinitions := coreregistry.NewToolRegistry([]coreregistry.Tool{{
		ToolID: "ANALYSIS-FETCH", Name: "test.analysis_fetch", Status: "active_mcp_schema_present",
		AllowedRoles: []string{"Platform Admin"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-v1")
	rules := coreregistry.NewRuleRegistry([]coreregistry.Rule{{
		RuleID: "TEST-DATA-001", RuleType: "data_confidentiality", Domain: "global",
		Condition:         coreregistry.RuleCondition{Type: "sensitive_key", Parameter: "input", Operator: "not_exists", Value: []interface{}{"salary"}},
		EnforcementAction: "block", ValidatorMessage: "Salary data cannot leave to a model provider.", Enabled: true,
	}}, "rules-v1")
	store := repository.NewStore()
	validator := workflowvalidator.NewRegistryValidator(toolDefinitions, rules, store)
	fetch := &handlerAnalysisFetchTool{}
	toolRegistry := tools.NewRegistry(nil)
	toolRegistry.Register(fetch)
	executor := runner.NewExecutor(toolRegistry, validator, zap.NewNop())
	provider := &handlerAnalysisProviderSpy{}
	executor.SetAnalysisProvider(provider)
	handler := &Handler{
		Store: store, Validator: workflowvalidator.NewWorkflowValidator(), RegistryValidator: validator,
		Runner: executor, Dataset: &coreregistry.Bundle{Tools: toolDefinitions, Rules: rules},
		Healer: &healing.Healer{MaxAttempts: 1}, Log: zap.NewNop(),
	}
	store.Users["admin"] = &models.User{ID: "admin", Name: "Admin", Status: "Active", RoleID: repository.RolePlatformAdminID}
	store.Workflows["wf-analysis-egress"] = &models.Workflow{
		ID: "wf-analysis-egress", Name: "analysis egress", Status: models.StatusPending,
		YAML: `name: analysis_egress
description: Prove confidential analysis input never leaves the process.
trigger:
  type: manual
steps:
  - id: fetch
    action: test.analysis_fetch
  - kind: analysis
    id: inspect
    instruction: Return the records.
    input: "{{fetch.output}}"
    output_schema:
      type: array
      items:
        type: object
`,
	}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, "admin")
		return c.Next()
	})
	app.Post("/workflows/:id/run", handler.RunWorkflow)

	response := gateRequest(t, app, "POST", "/workflows/wf-analysis-egress/run", map[string]interface{}{})
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", response.StatusCode, responseBody(t, response))
	}
	execution := executionForWorkflow(store, "wf-analysis-egress")
	if execution == nil || execution.Status != models.StatusFailed || execution.Failure == nil {
		t.Fatalf("expected terminal FAILED execution with classification, got %+v", execution)
	}
	if execution.Failure.FailureCategory != models.FailureCategoryPolicyViolation || execution.Failure.ToolWasCalled {
		t.Fatalf("egress failure classification is not a pre-dispatch policy block: %+v", execution.Failure)
	}
	if _, exists := store.Healing[execution.ID]; exists {
		t.Fatal("data-egress violation entered healing")
	}
	if provider.calls != 0 {
		t.Fatalf("provider called %d times for blocked egress", provider.calls)
	}
}
