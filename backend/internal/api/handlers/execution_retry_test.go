package handlers

import (
	"net/http"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

// retryTestApplication wires POST /executions/:id/retry behind the same
// RequireAnyPermission set the real router uses, so a Client holding only
// workflow:run_own reaches the handler instead of being rejected at the gate.
func retryTestApplication(t *testing.T) *fiber.App {
	t.Helper()
	registryValidator, store, executor, _ := newGateComponents()
	registryValidator.Tools.ReplaceAll([]registry.Tool{{
		ToolID: "TEST-TOOL-001", Name: "test.transfer", Status: "active_mcp_schema_present",
		AllowedRoles: []string{"Platform Admin", "Workflow Builder", "Client"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-retry-v1")

	store.Users["builder"] = &models.User{ID: "builder", Name: "Builder", Status: "Active", RoleID: repository.RoleBuilderID}
	store.Users["client-a"] = &models.User{ID: "client-a", Name: "Client A", Status: "Active", RoleID: repository.RoleClientID}
	store.Users["client-b"] = &models.User{ID: "client-b", Name: "Client B", Status: "Active", RoleID: repository.RoleClientID}

	now := time.Now().UTC()
	store.Workflows["wf-a"] = scopedTestWorkflow("wf-a", "Client A Workflow", "client-a", now)
	store.Workflows["wf-b"] = scopedTestWorkflow("wf-b", "Client B Workflow", "client-b", now)
	store.Executions["exec-a"] = &models.Execution{
		ID: "exec-a", WorkflowID: "wf-a", WorkflowName: "Client A Workflow",
		StartedAt: now, StartedBy: models.Principal{ID: "client-a", Name: "Client A"},
	}
	store.Executions["exec-b"] = &models.Execution{
		ID: "exec-b", WorkflowID: "wf-b", WorkflowName: "Client B Workflow",
		StartedAt: now, StartedBy: models.Principal{ID: "client-b", Name: "Client B"},
	}

	handler := &Handler{
		Store: store, Validator: workflowvalidator.NewWorkflowValidator(),
		RegistryValidator: registryValidator, Runner: executor, Log: zap.NewNop(),
	}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, c.Get("X-Test-User"))
		return c.Next()
	})
	workflowRunAny := middlewares.RequireAnyPermission([]string{"workflow:run", "workflow:run_own"}, handler.Permissions)
	app.Post("/executions/:id/retry", workflowRunAny, handler.RetryExecution)
	return app
}

func TestClientCanRetryOwnExecution(t *testing.T) {
	app := retryTestApplication(t)
	response := registryTestRequest(t, app, http.MethodPost, "/executions/exec-a/retry", "client-a", map[string]interface{}{"input": map[string]interface{}{}})
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("client retry of its own execution = %d, want 200: %s", response.StatusCode, body)
	}
}

func TestClientCannotRetryOthersExecution(t *testing.T) {
	app := retryTestApplication(t)
	response := registryTestRequest(t, app, http.MethodPost, "/executions/exec-b/retry", "client-a", map[string]interface{}{"input": map[string]interface{}{}})
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusNotFound {
		t.Fatalf("client retry of another client's execution = %d, want 404: %s", response.StatusCode, body)
	}
}

func TestBuilderCanRetryAnyExecution(t *testing.T) {
	app := retryTestApplication(t)
	for _, executionID := range []string{"exec-a", "exec-b"} {
		response := registryTestRequest(t, app, http.MethodPost, "/executions/"+executionID+"/retry", "builder", map[string]interface{}{"input": map[string]interface{}{}})
		body := responseBody(t, response)
		response.Body.Close()
		if response.StatusCode != fiber.StatusOK {
			t.Fatalf("builder retry of %s = %d, want 200: %s", executionID, response.StatusCode, body)
		}
	}
}
