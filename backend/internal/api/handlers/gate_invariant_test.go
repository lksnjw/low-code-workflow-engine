package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

type handlerSpyTool struct {
	calls int
	// failure, when set, is returned instead of a result. failAfter lets a
	// multi-step run succeed for the first N calls and fail afterwards, which
	// is how a partial-output run is produced.
	failure   error
	failAfter int
}

func (s *handlerSpyTool) Name() string        { return "test.transfer" }
func (s *handlerSpyTool) Description() string { return "handler gate spy" }
func (s *handlerSpyTool) Execute(_ context.Context, _ workflowvalidator.DispatchCapability, _ map[string]interface{}) (map[string]interface{}, error) {
	s.calls++
	if s.failure != nil && s.calls > s.failAfter {
		return nil, s.failure
	}
	return map[string]interface{}{"ok": true}, nil
}

func TestHandlerConstructorRejectsNilRegistryValidator(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected nil registry validator to panic at handler construction")
		}
	}()
	New(config.Config{}, nil, nil, nil, nil, nil, nil, nil, nil, nil, zap.NewNop())
}

func TestWorkflowWritePathsRejectInvalidDefinitionsWithoutPersistence(t *testing.T) {
	t.Run("CreateWorkflow", func(t *testing.T) {
		_, store, app, _ := newGateTestHandler()
		before := len(store.Workflows)
		response := gateRequest(t, app, http.MethodPost, "/workflows", map[string]interface{}{"name": "invalid", "yaml": unknownToolYAML()})
		if response.StatusCode != fiber.StatusUnprocessableEntity {
			t.Fatalf("expected 422, got %d", response.StatusCode)
		}
		if len(store.Workflows) != before {
			t.Fatal("invalid create persisted a workflow")
		}
	})

	t.Run("UpdateWorkflow", func(t *testing.T) {
		_, store, app, _ := newGateTestHandler()
		store.Workflows["wf-invalid"] = &models.Workflow{ID: "wf-invalid", Name: "before", YAML: unknownToolYAML()}
		response := gateRequest(t, app, http.MethodPatch, "/workflows/wf-invalid", map[string]interface{}{"name": "after"})
		if response.StatusCode != fiber.StatusUnprocessableEntity {
			t.Fatalf("expected 422, got %d", response.StatusCode)
		}
		if store.Workflows["wf-invalid"].Name != "before" {
			t.Fatal("invalid update mutated the stored workflow")
		}
	})

	t.Run("PutWorkflowYAML", func(t *testing.T) {
		_, store, app, _ := newGateTestHandler()
		original := validWorkflowYAML("25")
		store.Workflows["wf-put"] = &models.Workflow{ID: "wf-put", Name: "put", YAML: original, DraftVersion: 1}
		response := gateRequest(t, app, http.MethodPut, "/workflows/wf-put/yaml", map[string]interface{}{"yaml": unknownToolYAML()})
		if response.StatusCode != fiber.StatusUnprocessableEntity {
			t.Fatalf("expected 422, got %d", response.StatusCode)
		}
		if store.Workflows["wf-put"].YAML != original || store.Workflows["wf-put"].DraftVersion != 1 {
			t.Fatal("invalid YAML update mutated the stored workflow")
		}
	})
}

func TestPublishAndRestoreRejectStoredInvalidYAML(t *testing.T) {
	t.Run("PublishWorkflow", func(t *testing.T) {
		_, store, app, _ := newGateTestHandler()
		store.Workflows["wf-publish"] = &models.Workflow{ID: "wf-publish", Name: "publish", YAML: unknownToolYAML(), DraftVersion: 2}
		response := gateRequest(t, app, http.MethodPost, "/workflows/wf-publish/publish", map[string]interface{}{"versionNote": "invalid"})
		if response.StatusCode != fiber.StatusUnprocessableEntity {
			t.Fatalf("expected 422, got %d", response.StatusCode)
		}
		if len(store.Versions["wf-publish"]) != 0 || store.Workflows["wf-publish"].PublishedVersion != 0 {
			t.Fatal("invalid publish created a version")
		}
	})

	t.Run("RestoreWorkflowVersion", func(t *testing.T) {
		_, store, app, _ := newGateTestHandler()
		original := validWorkflowYAML("25")
		store.Workflows["wf-restore"] = &models.Workflow{ID: "wf-restore", Name: "restore", YAML: original, DraftVersion: 3}
		store.Versions["wf-restore"] = []models.WorkflowVersion{{ID: "ver-invalid", WorkflowID: "wf-restore", YAML: unknownToolYAML()}}
		response := gateRequest(t, app, http.MethodPost, "/workflows/wf-restore/versions/ver-invalid/restore", nil)
		if response.StatusCode != fiber.StatusUnprocessableEntity {
			t.Fatalf("expected 422, got %d", response.StatusCode)
		}
		if store.Workflows["wf-restore"].YAML != original || store.Workflows["wf-restore"].DraftVersion != 3 {
			t.Fatal("invalid restore mutated the stored workflow")
		}
	})
}

func TestUseTemplateInvalidResultDoesNotPersistOrCreateEmptyCanvas(t *testing.T) {
	_, store, app, _ := newGateTestHandler()
	store.Templates["tpl-invalid"] = &models.WorkflowTemplate{ID: "tpl-invalid", Name: "invalid", YAML: unknownToolYAML(), CreatedAt: time.Now().UTC()}
	before := len(store.Workflows)
	response := gateRequest(t, app, http.MethodPost, "/templates/tpl-invalid/use", map[string]interface{}{"name": "from invalid"})
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", response.StatusCode)
	}
	if len(store.Workflows) != before {
		t.Fatal("invalid template persisted a workflow or empty canvas fallback")
	}
}

func TestFullGateValidationEndpointsRejectUnknownTool(t *testing.T) {
	_, store, app, _ := newGateTestHandler()
	store.Workflows["wf-validate"] = &models.Workflow{ID: "wf-validate", YAML: validWorkflowYAML("25")}
	tests := []struct {
		name string
		path string
	}{
		{name: "ValidateWorkflow", path: "/workflows/wf-validate/validate"},
		{name: "SynthesisValidate", path: "/synthesis/validate"},
		{name: "CanvasValidateWorkflow", path: "/canvas/validate-workflow"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := gateRequest(t, app, http.MethodPost, test.path, map[string]interface{}{"yaml": unknownToolYAML()})
			if response.StatusCode != fiber.StatusOK {
				t.Fatalf("expected 200 validation report, got %d", response.StatusCode)
			}
			body := responseBody(t, response)
			if !strings.Contains(body, `"tool_validity_ok":false`) || !strings.Contains(body, `"passed":false`) {
				t.Fatalf("endpoint did not return the full registry result: %s", body)
			}
		})
	}
}

func TestCanvasSemanticChangeMarksDraftUnvalidatedAndRunRefuses(t *testing.T) {
	_, store, app, spy := newGateTestHandler()
	store.Workflows["wf-canvas"] = &models.Workflow{ID: "wf-canvas", Name: "canvas", YAML: validWorkflowYAML("25"), Status: models.StatusPending}
	response := gateRequest(t, app, http.MethodPut, "/workflows/wf-canvas/canvas", map[string]interface{}{
		"nodes": []map[string]interface{}{{"id": "transfer", "type": "action", "config": map[string]interface{}{"amount": 90}}},
		"edges": []interface{}{}, "viewport": map[string]interface{}{"x": 0, "y": 0, "zoom": 1},
	})
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("expected canvas update 200, got %d", response.StatusCode)
	}
	if store.Workflows["wf-canvas"].Status != models.StatusDraftUnvalidated {
		t.Fatalf("expected %q, got %q", models.StatusDraftUnvalidated, store.Workflows["wf-canvas"].Status)
	}
	runResponse := gateRequest(t, app, http.MethodPost, "/workflows/wf-canvas/run", map[string]interface{}{"input": map[string]interface{}{"amount": 25}})
	if runResponse.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected run refusal 422, got %d", runResponse.StatusCode)
	}
	if spy.calls != 0 {
		t.Fatalf("draft-unvalidated workflow executed %d tool calls", spy.calls)
	}
}

func TestDispatchViolationMarksExecutionFailedWithoutHealing(t *testing.T) {
	_, store, app, spy := newGateTestHandler()
	store.Workflows["wf-dispatch"] = &models.Workflow{ID: "wf-dispatch", Name: "dispatch", YAML: validWorkflowYAML(`"{{input.amount}}"`), Status: models.StatusPending}
	beforeHealing := len(store.Healing)
	response := gateRequest(t, app, http.MethodPost, "/workflows/wf-dispatch/run", map[string]interface{}{"input": map[string]interface{}{"amount": 101}})
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected failed execution result 422, got %d: %s", response.StatusCode, responseBody(t, response))
	}
	var execution *models.Execution
	for _, candidate := range store.Executions {
		if candidate.WorkflowID == "wf-dispatch" {
			execution = candidate
		}
	}
	if execution == nil || execution.Status != models.StatusFailed {
		t.Fatalf("expected FAILED execution, got %+v", execution)
	}
	if len(store.Healing) != beforeHealing {
		t.Fatal("dispatch policy violation was routed to healing")
	}
	if spy.calls != 0 {
		t.Fatalf("dispatch violation executed %d tool calls", spy.calls)
	}
	dispatchAuditFound := false
	for _, entry := range store.AuditLogs {
		if strings.HasPrefix(entry.Action, "validation.gate.dispatch.") && entry.After["passed"] == false {
			dispatchAuditFound = true
			break
		}
	}
	if !dispatchAuditFound {
		t.Fatal("dispatch policy violation was not written to the existing audit store")
	}
}

func TestUnknownYAMLFieldRejectedByStrictGate(t *testing.T) {
	validator, _, _, _ := newGateComponents()
	raw := validWorkflowYAML("25") + "misspelled_field: true\n"
	token, result, err := validator.ValidateAndIssueToken("strict-yaml", raw, "Platform Admin")
	if err != nil {
		t.Fatalf("validation returned error: %v", err)
	}
	if result.Passed || result.SchemaOK || token != nil {
		t.Fatalf("unknown YAML field was accepted: %+v", result)
	}
}

func TestGateDecisionsAreRecordedWithRequiredAuditEvidence(t *testing.T) {
	validator, store, _, _ := newGateComponents()
	before := len(store.AuditLogs)
	_, _, _ = validator.ValidateAndIssueToken("audit-pass", validWorkflowYAML("25"), "Platform Admin")
	_, _, _ = validator.ValidateAndIssueToken("audit-fail", unknownToolYAML(), "Platform Admin")
	if len(store.AuditLogs) != before+2 {
		t.Fatalf("expected two gate audit entries, got %d", len(store.AuditLogs)-before)
	}
	for _, action := range []string{"validation.gate.audit-pass", "validation.gate.audit-fail"} {
		found := false
		for _, entry := range store.AuditLogs {
			if entry.Action != action {
				continue
			}
			found = entry.After["path_action"] != nil && entry.After["passed"] != nil && entry.After["rule_results"] != nil && entry.After["registry_hash"] != nil && entry.After["workflow_content_hash"] != nil && entry.After["timestamp"] != nil
		}
		if !found {
			t.Fatalf("missing required evidence for %s", action)
		}
	}
}

func newGateTestHandler() (*Handler, *repository.Store, *fiber.App, *handlerSpyTool) {
	registryValidator, store, executor, spy := newGateComponents()
	handler := New(config.Config{}, store, nil, workflowvalidator.NewWorkflowValidator(), nil, registryValidator, nil, nil, executor, nil, zap.NewNop())
	app := fiber.New()
	store.Users["test-admin"] = &models.User{ID: "test-admin", Name: "Test Admin", RoleID: repository.RolePlatformAdminID}
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, "test-admin")
		return c.Next()
	})
	app.Post("/workflows", handler.CreateWorkflow)
	app.Patch("/workflows/:id", handler.UpdateWorkflow)
	app.Put("/workflows/:id/yaml", handler.PutWorkflowYAML)
	app.Post("/workflows/:id/publish", handler.PublishWorkflow)
	app.Post("/workflows/:id/versions/:versionId/restore", handler.RestoreWorkflowVersion)
	app.Post("/templates/:id/use", handler.UseTemplate)
	app.Post("/workflows/:id/validate", handler.ValidateWorkflow)
	app.Post("/synthesis/validate", handler.SynthesisValidate)
	app.Post("/canvas/validate-workflow", handler.CanvasValidateWorkflow)
	app.Put("/workflows/:id/canvas", handler.PutWorkflowCanvas)
	app.Post("/workflows/:id/run", handler.RunWorkflow)
	return handler, store, app, spy
}

func newGateComponents() (*workflowvalidator.RegistryValidator, *repository.Store, *runner.Executor, *handlerSpyTool) {
	toolDefinitions := coreregistry.NewToolRegistry([]coreregistry.Tool{{
		ToolID: "TEST-TOOL-001", Name: "test.transfer", Status: "active_mcp_schema_present",
		AllowedRoles: []string{"Platform Admin", "Workflow Builder"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-v1")
	rules := coreregistry.NewRuleRegistry([]coreregistry.Rule{
		{
			RuleID: "TEST-THRESH-001", RuleType: "amount_threshold", Domain: "test",
			AppliesToTools: []string{"test.transfer"}, Condition: coreregistry.RuleCondition{Parameter: "amount", Operator: ">", Value: 100},
			EnforcementAction: "require_human_approval", Enabled: true,
		},
		{RuleID: "GLOBAL-SAFETY-002", RuleType: "data_confidentiality", Domain: "global", EnforcementAction: "block", Enabled: true},
	}, "rules-v1")
	store := repository.NewStore()
	validator := workflowvalidator.NewRegistryValidator(toolDefinitions, rules, store)
	spy := &handlerSpyTool{}
	toolRegistry := tools.NewRegistry(nil)
	toolRegistry.Register(spy)
	executor := runner.NewExecutor(toolRegistry, validator, zap.NewNop())
	return validator, store, executor, spy
}

func gateRequest(t *testing.T, app *fiber.App, method, path string, payload interface{}) *http.Response {
	t.Helper()
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	return response
}

func responseBody(t *testing.T, response *http.Response) string {
	t.Helper()
	var buffer bytes.Buffer
	if _, err := buffer.ReadFrom(response.Body); err != nil {
		t.Fatalf("read response: %v", err)
	}
	return buffer.String()
}

func validWorkflowYAML(amount string) string {
	return `name: gate_test
description: Exercise a deterministic validation gate.
trigger:
  type: manual
steps:
  - id: transfer
    action: test.transfer
    parameters:
      amount: ` + amount + "\n"
}

func unknownToolYAML() string {
	return `name: invalid_gate_test
description: References an unknown tool.
trigger:
  type: manual
steps:
  - id: invalid
    action: unknown.tool
    parameters: {}
`
}
