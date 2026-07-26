package handlers

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/company"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestRelevanceComputedBackendSide(t *testing.T) {
	_, app := relevanceTestApplication()
	builderRelevant := relevanceResponse(t, app, "/workflows?relevance=relevant", "builder")
	builderAll := relevanceResponse(t, app, "/workflows?relevance=all", "builder")
	clientRelevant := relevanceResponse(t, app, "/workflows?relevance=relevant", "client")

	if !strings.Contains(builderRelevant, `"id":"wf-finance"`) || strings.Contains(builderRelevant, `"id":"wf-hr"`) {
		t.Fatalf("builder relevant response was not filtered server-side: %s", builderRelevant)
	}
	if !strings.Contains(builderAll, `"id":"wf-finance"`) || !strings.Contains(builderAll, `"id":"wf-hr"`) {
		t.Fatalf("builder all response did not contain both global records: %s", builderAll)
	}
	if !strings.Contains(clientRelevant, `"id":"wf-client"`) ||
		strings.Contains(clientRelevant, `"id":"wf-finance"`) ||
		strings.Contains(clientRelevant, `"id":"wf-hr"`) {
		t.Fatalf("client response weakened own scoping: %s", clientRelevant)
	}
	t.Logf("builder GET /workflows?relevance=relevant -> %s", builderRelevant)
	t.Logf("client GET /workflows?relevance=relevant -> %s", clientRelevant)
}

func TestRelevanceDefaultsToRelevantForNonAdmins(t *testing.T) {
	_, app := relevanceTestApplication()
	response := relevanceResponse(t, app, "/workflows", "reviewer")
	if !strings.Contains(response, `"id":"wf-finance"`) ||
		strings.Contains(response, `"id":"wf-hr"`) ||
		!strings.Contains(response, `"relevance":"relevant"`) {
		t.Fatalf("non-admin default response was not relevant-only: %s", response)
	}
}

func relevanceTestApplication() (*Handler, *fiber.App) {
	store := repository.NewStore()
	departmentID := "dept-finance"
	profile := company.DefaultProfile()
	profile.Departments = []company.Department{{ID: departmentID, Name: "Finance", Domains: []string{"finance"}}}
	store.CompanyProfile, _ = company.Encode(profile)
	store.Users["builder"] = &models.User{ID: "builder", Name: "Builder", Status: "Active", RoleID: repository.RoleBuilderID, DepartmentID: &departmentID}
	store.Users["client"] = &models.User{ID: "client", Name: "Client", Status: "Active", RoleID: repository.RoleClientID, DepartmentID: &departmentID}
	store.Roles["role_reviewer"] = &models.Role{ID: "role_reviewer", Name: "Execution Reviewer", Permissions: []string{"workflow:read"}}
	store.Users["reviewer"] = &models.User{ID: "reviewer", Name: "Reviewer", Status: "Active", RoleID: "role_reviewer", DepartmentID: &departmentID}
	now := time.Now().UTC()
	store.Workflows["wf-finance"] = relevanceWorkflow("wf-finance", "somebody", "finance.read", []string{"finance"}, now)
	store.Workflows["wf-hr"] = relevanceWorkflow("wf-hr", "somebody", "hr.private", []string{"hr"}, now)
	store.Workflows["wf-client"] = relevanceWorkflow("wf-client", "client", "finance.read", []string{"finance"}, now)
	tools := []registry.Tool{
		{ToolID: "FIN", Name: "finance.read", Module: "finance", Status: "active_mcp_schema_present", AllowedRoles: []string{"Workflow Builder", "Client"}},
		{ToolID: "HR", Name: "hr.private", Module: "hr", Status: "active_mcp_schema_present", AllowedRoles: []string{"HR Manager"}},
	}
	bundle := &registry.Bundle{
		Tools: registry.NewToolRegistry(tools, "tools-relevance"),
		Rules: registry.NewRuleRegistry(nil, "rules-relevance"),
	}
	handler := &Handler{Store: store, Dataset: bundle, RegistryManager: registry.NewManager(bundle, "", "")}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, c.Get("X-Test-User"))
		return c.Next()
	})
	app.Get("/workflows", handler.ListWorkflows)
	return handler, app
}

func relevanceWorkflow(id, ownerID, action string, domainTags []string, now time.Time) *models.Workflow {
	return &models.Workflow{
		ID: id, Name: id, Owner: models.Principal{ID: ownerID}, Status: models.StatusPending,
		DomainTags: domainTags,
		YAML:       "name: " + id + "\ntrigger:\n  type: manual\nsteps:\n  - id: step\n    action: " + action + "\n",
		CreatedAt:  now, UpdatedAt: now,
	}
}

func relevanceResponse(t *testing.T, app *fiber.App, path, userID string) string {
	t.Helper()
	response := registryTestRequest(t, app, http.MethodGet, path, userID, nil)
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("%s returned %d: %s", path, response.StatusCode, body)
	}
	return body
}
