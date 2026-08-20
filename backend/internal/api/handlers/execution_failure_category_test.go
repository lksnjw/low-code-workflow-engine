package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

// failureCategoryApp wires a runner whose single registered tool is the shared
// handler spy, so a tool failure and a policy block can be produced on demand.
func failureCategoryApp(t *testing.T) (*Handler, *fiber.App, *handlerSpyTool) {
	t.Helper()
	registryValidator, store, executor, spy := newGateComponents()
	registryValidator.Rules.ReplaceAll([]coreregistry.Rule{{
		RuleID: "TEST-THRESH-001", RuleType: "amount_threshold", Domain: "test",
		AppliesToTools:    []string{"test.transfer"},
		Condition:         coreregistry.RuleCondition{Parameter: "amount", Operator: ">", Value: 100},
		EnforcementAction: "block", Enabled: true,
		ValidatorMessage: "Transfer amount exceeds the allowed maximum of 100.",
	}}, "rules-failure-v1")

	store.Users["admin"] = &models.User{ID: "admin", Name: "Admin", Status: "Active", RoleID: repository.RolePlatformAdminID}
	handler := &Handler{
		Store: store, Validator: workflowvalidator.NewWorkflowValidator(),
		RegistryValidator: registryValidator, Runner: executor,
		Dataset: &coreregistry.Bundle{Tools: registryValidator.Tools, Rules: registryValidator.Rules},
		Log:     zap.NewNop(),
	}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, c.Get("X-Test-User"))
		return c.Next()
	})
	app.Post("/workflows", handler.CreateWorkflow)
	app.Post("/workflows/:id/run", handler.RunWorkflow)
	app.Get("/executions/:id", handler.GetExecution)
	app.Get("/executions/:id/logs", handler.ExecutionLogs)
	app.Get("/executions/:id/timeline", handler.ExecutionTimeline)
	return handler, app, spy
}

func decodeJSONBody(t *testing.T, response *http.Response) map[string]interface{} {
	t.Helper()
	var out map[string]interface{}
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return out
}

func runDeferredWorkflow(t *testing.T, app *fiber.App, amount interface{}) map[string]interface{} {
	t.Helper()
	yaml := "name: failure_category\ndescription: Deferred amount for dispatch evaluation.\n" +
		"trigger:\n  type: manual\nsteps:\n  - id: transfer\n    action: test.transfer\n" +
		"    parameters:\n      amount: '{{input.amount}}'\n"
	created := registryTestRequest(t, app, http.MethodPost, "/workflows", "admin", map[string]interface{}{"name": "failure category", "yaml": yaml})
	createdBody := decodeJSONBody(t, created)
	created.Body.Close()
	data, _ := createdBody["data"].(map[string]interface{})
	if data == nil {
		t.Fatalf("workflow was not created: %+v", createdBody)
	}
	id, _ := data["id"].(string)

	response := registryTestRequest(t, app, http.MethodPost, "/workflows/"+id+"/run", "admin", map[string]interface{}{"input": map[string]interface{}{"amount": amount}})
	body := decodeJSONBody(t, response)
	response.Body.Close()
	return body
}

func executionFailureBlock(t *testing.T, app *fiber.App, executionID string) map[string]interface{} {
	t.Helper()
	response := registryTestRequest(t, app, http.MethodGet, "/executions/"+executionID, "admin", nil)
	body := decodeJSONBody(t, response)
	response.Body.Close()
	data, _ := body["data"].(map[string]interface{})
	if data == nil {
		t.Fatalf("execution %s not returned: %+v", executionID, body)
	}
	failure, _ := data["failure"].(map[string]interface{})
	if failure == nil {
		t.Fatalf("execution %s carries no failure block: %+v", executionID, data)
	}
	if status, _ := data["status"].(string); status != models.StatusFailed {
		t.Fatalf("execution status = %v, want FAILED (the status enum must not change)", data["status"])
	}
	return failure
}

func TestExecutionRecordsPolicyViolationCategory(t *testing.T) {
	_, app, _ := failureCategoryApp(t)
	body := runDeferredWorkflow(t, app, 150)
	meta, _ := body["meta"].(map[string]interface{})
	executionID, _ := meta["executionId"].(string)
	if executionID == "" {
		t.Fatalf("no executionId returned: %+v", body)
	}
	failure := executionFailureBlock(t, app, executionID)
	if failure["failureCategory"] != models.FailureCategoryPolicyViolation {
		t.Fatalf("failureCategory = %v, want %s", failure["failureCategory"], models.FailureCategoryPolicyViolation)
	}
}

func TestPolicyViolationRecordsRuleIdParameterAndToolNotCalled(t *testing.T) {
	_, app, spy := failureCategoryApp(t)
	body := runDeferredWorkflow(t, app, 150)
	meta, _ := body["meta"].(map[string]interface{})
	executionID, _ := meta["executionId"].(string)
	failure := executionFailureBlock(t, app, executionID)

	if failure["ruleId"] != "TEST-THRESH-001" {
		t.Fatalf("ruleId = %v, want TEST-THRESH-001", failure["ruleId"])
	}
	if failure["blockedParameter"] != "amount" {
		t.Fatalf("blockedParameter = %v, want amount", failure["blockedParameter"])
	}
	if failure["ruleMessage"] != "Transfer amount exceeds the allowed maximum of 100." {
		t.Fatalf("ruleMessage = %v, want the registry validator_message", failure["ruleMessage"])
	}
	if failure["failedToolName"] != "test.transfer" {
		t.Fatalf("failedToolName = %v, want test.transfer", failure["failedToolName"])
	}
	if called, _ := failure["toolWasCalled"].(bool); called {
		t.Fatal("toolWasCalled = true, but a policy violation is decided before dispatch")
	}
	if spy.calls != 0 {
		t.Fatalf("spy tool was invoked %d times, want 0 for a policy-blocked step", spy.calls)
	}

	// The failing timeline step must carry the same classification.
	response := registryTestRequest(t, app, http.MethodGet, "/executions/"+executionID+"/timeline", "admin", nil)
	timelineBody := decodeJSONBody(t, response)
	response.Body.Close()
	steps, _ := timelineBody["data"].([]interface{})
	found := false
	for _, raw := range steps {
		step, _ := raw.(map[string]interface{})
		if step == nil || step["status"] != models.StatusFailed {
			continue
		}
		stepFailure, _ := step["failure"].(map[string]interface{})
		if stepFailure == nil || stepFailure["ruleId"] != "TEST-THRESH-001" {
			t.Fatalf("failing timeline step carries no policy classification: %+v", step)
		}
		found = true
	}
	if !found {
		t.Fatalf("no FAILED timeline step found: %+v", steps)
	}
}

func TestToolFailureRecordsToolFailureCategory(t *testing.T) {
	_, app, spy := failureCategoryApp(t)
	spy.failure = errors.New("connector timeout")
	body := runDeferredWorkflow(t, app, 10) // under the threshold, so the gate allows dispatch
	meta, _ := body["meta"].(map[string]interface{})
	executionID, _ := meta["executionId"].(string)
	if executionID == "" {
		t.Fatalf("no executionId returned: %+v", body)
	}
	failure := executionFailureBlock(t, app, executionID)
	if failure["failureCategory"] != models.FailureCategoryToolFailure {
		t.Fatalf("failureCategory = %v, want %s", failure["failureCategory"], models.FailureCategoryToolFailure)
	}
	if called, _ := failure["toolWasCalled"].(bool); !called {
		t.Fatal("toolWasCalled = false, but the tool did run and returned an error")
	}
	if failure["ruleId"] != nil && failure["ruleId"] != "" {
		t.Fatalf("ruleId = %v, want empty for a tool failure", failure["ruleId"])
	}
	if spy.calls == 0 {
		t.Fatal("spy tool was never invoked, so this is not a tool failure")
	}
}
