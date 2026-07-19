package handlers

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"go.uber.org/zap"
)

func TestClientScopeAndWorkflowAssignment(t *testing.T) {
	registryValidator, store, executor, _ := newGateComponents()
	registryValidator.Tools.ReplaceAll([]registry.Tool{{
		ToolID: "TEST-TOOL-001", Name: "test.transfer", Status: "active_mcp_schema_present",
		AllowedRoles: []string{"Platform Admin", "Client"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-client-v1")

	store.Users["admin"] = &models.User{ID: "admin", Name: "Admin", Status: "Active", Role: models.RoleRef{ID: "role_admin", Name: "Platform Admin"}, Permissions: []string{"workflow:read", "workflow:write", "workflow:run"}}
	store.Users["client-a"] = &models.User{ID: "client-a", Name: "Client A", Status: "Active", Role: models.RoleRef{ID: "role_client", Name: "Client"}, Permissions: []string{"chat:use", "workflow:read_own", "workflow:run_own", "execution:read_own"}}
	store.Users["client-b"] = &models.User{ID: "client-b", Name: "Client B", Status: "Active", Role: models.RoleRef{ID: "role_client", Name: "Client"}, Permissions: []string{"chat:use", "workflow:read_own", "workflow:run_own", "execution:read_own"}}

	now := time.Now().UTC()
	store.Workflows["wf-a"] = scopedTestWorkflow("wf-a", "Client A Workflow", "client-a", now)
	store.Workflows["wf-b"] = scopedTestWorkflow("wf-b", "Client B Workflow", "client-b", now)
	store.Workflows["wf-shared"] = scopedTestWorkflow("wf-shared", "Assignable Workflow", "admin", now)
	store.Executions["exec-a"] = &models.Execution{ID: "exec-a", WorkflowID: "wf-a", WorkflowName: "Client A Workflow", StartedAt: now, StartedBy: models.Principal{ID: "client-a", Name: "Client A"}}
	store.Executions["exec-b"] = &models.Execution{ID: "exec-b", WorkflowID: "wf-b", WorkflowName: "Client B Workflow", StartedAt: now, StartedBy: models.Principal{ID: "client-b", Name: "Client B"}}
	store.ExecutionLogs["exec-a"] = []models.ExecutionLog{{ID: "log-a", ExecutionID: "exec-a", Message: "Client A log"}}
	store.ExecutionLogs["exec-b"] = []models.ExecutionLog{{ID: "log-b", ExecutionID: "exec-b", Message: "Client B log"}}
	store.Chats["chat-a"] = &models.ChatSessionDetail{ChatSession: models.ChatSession{ID: "chat-a", OwnerID: "client-a", Title: "Client A chat"}}
	store.Chats["chat-b"] = &models.ChatSessionDetail{ChatSession: models.ChatSession{ID: "chat-b", OwnerID: "client-b", Title: "Client B chat"}}

	handler := &Handler{Store: store, Validator: workflowvalidator.NewWorkflowValidator(), RegistryValidator: registryValidator, Runner: executor, Log: zap.NewNop()}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, c.Get("X-Test-User"))
		return c.Next()
	})
	workflowReadAny := middlewares.RequireAnyPermission([]string{"workflow:read", "workflow:read_own"}, handler.Permissions)
	workflowRunAny := middlewares.RequireAnyPermission([]string{"workflow:run", "workflow:run_own"}, handler.Permissions)
	executionReadAny := middlewares.RequireAnyPermission([]string{"workflow:read", "execution:read_own"}, handler.Permissions)
	chatReadAny := middlewares.RequireAnyPermission([]string{"workflow:read", "chat:use"}, handler.Permissions)
	workflowWrite := middlewares.RequirePermission("workflow:write", handler.Permissions)
	app.Get("/workflows", workflowReadAny, handler.ListWorkflows)
	app.Get("/workflows/:id", workflowReadAny, handler.GetWorkflow)
	app.Post("/workflows/:id/run", workflowRunAny, handler.RunWorkflow)
	app.Post("/workflows/:id/assign", workflowWrite, handler.AssignWorkflowUser)
	app.Get("/executions", executionReadAny, handler.ListExecutions)
	app.Get("/executions/:id", executionReadAny, handler.GetExecution)
	app.Get("/executions/:id/logs", executionReadAny, handler.ExecutionLogs)
	app.Get("/chat/sessions", chatReadAny, handler.ListChatSessions)
	app.Get("/chat/sessions/:id", chatReadAny, handler.GetChatSession)

	listBefore := scopedResponseBody(t, registryTestRequest(t, app, http.MethodGet, "/workflows", "client-a", nil))
	if !strings.Contains(listBefore, "wf-a") || strings.Contains(listBefore, "wf-b") || strings.Contains(listBefore, "wf-shared") {
		t.Fatalf("client workflow list was not owner-scoped before assignment: %s", listBefore)
	}

	getB := registryTestRequest(t, app, http.MethodGet, "/workflows/wf-b", "client-a", nil)
	if getB.StatusCode != fiber.StatusNotFound {
		t.Fatalf("client A read client B workflow with status %d", getB.StatusCode)
	}
	getB.Body.Close()
	runB := registryTestRequest(t, app, http.MethodPost, "/workflows/wf-b/run", "client-a", map[string]interface{}{"input": map[string]interface{}{}})
	if runB.StatusCode != fiber.StatusForbidden {
		t.Fatalf("client A ran client B workflow with status %d", runB.StatusCode)
	}
	runB.Body.Close()

	assign := registryTestRequest(t, app, http.MethodPost, "/workflows/wf-shared/assign", "admin", map[string]interface{}{"userId": "client-a"})
	if assign.StatusCode != fiber.StatusOK {
		t.Fatalf("workflow assignment returned %d: %s", assign.StatusCode, responseBody(t, assign))
	}
	assign.Body.Close()
	listAfter := scopedResponseBody(t, registryTestRequest(t, app, http.MethodGet, "/workflows", "client-a", nil))
	if !strings.Contains(listAfter, "wf-shared") {
		t.Fatalf("assigned workflow was not visible to client A: %s", listAfter)
	}
	runAssigned := registryTestRequest(t, app, http.MethodPost, "/workflows/wf-shared/run", "client-a", map[string]interface{}{"input": map[string]interface{}{}})
	if runAssigned.StatusCode != fiber.StatusOK {
		t.Fatalf("assigned workflow was not runnable by client A: %d %s", runAssigned.StatusCode, responseBody(t, runAssigned))
	}
	runAssigned.Body.Close()

	executionList := scopedResponseBody(t, registryTestRequest(t, app, http.MethodGet, "/executions", "client-a", nil))
	if !strings.Contains(executionList, "exec-a") || strings.Contains(executionList, "exec-b") {
		t.Fatalf("client execution list was not started-by scoped: %s", executionList)
	}
	for _, path := range []string{"/executions/exec-b", "/executions/exec-b/logs"} {
		response := registryTestRequest(t, app, http.MethodGet, path, "client-a", nil)
		if response.StatusCode != fiber.StatusNotFound {
			t.Fatalf("client A accessed client B execution path %s with status %d", path, response.StatusCode)
		}
		response.Body.Close()
	}

	chatList := scopedResponseBody(t, registryTestRequest(t, app, http.MethodGet, "/chat/sessions", "client-a", nil))
	if !strings.Contains(chatList, "chat-a") || strings.Contains(chatList, "chat-b") {
		t.Fatalf("client chat list was not owner-scoped: %s", chatList)
	}
	chatB := registryTestRequest(t, app, http.MethodGet, "/chat/sessions/chat-b", "client-a", nil)
	if chatB.StatusCode != fiber.StatusNotFound {
		t.Fatalf("client A accessed client B chat with status %d", chatB.StatusCode)
	}
	chatB.Body.Close()

	adminList := scopedResponseBody(t, registryTestRequest(t, app, http.MethodGet, "/workflows", "admin", nil))
	for _, id := range []string{"wf-a", "wf-b", "wf-shared"} {
		if !strings.Contains(adminList, id) {
			t.Fatalf("admin list did not retain global access to %s: %s", id, adminList)
		}
	}
	auditFound := false
	for _, entry := range store.AuditLogs {
		if entry.Action == "workflow.user_assigned" && entry.Resource.ID == "wf-shared" {
			auditFound = true
		}
	}
	if !auditFound {
		t.Fatal("workflow assignment audit entry was not recorded")
	}
}

func scopedTestWorkflow(id, name, ownerID string, now time.Time) *models.Workflow {
	return &models.Workflow{
		ID: id, Name: name, Owner: models.Principal{ID: ownerID, Name: ownerID}, Status: models.StatusPending,
		YAML: validWorkflowYAML("25"), DraftVersion: 1, CreatedAt: now, UpdatedAt: now,
	}
}

func scopedResponseBody(t *testing.T, response *http.Response) string {
	t.Helper()
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("request returned %d: %s", response.StatusCode, body)
	}
	return body
}
