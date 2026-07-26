package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	generationcontext "github.com/sanjeewa/agentic-orchestrator/internal/core/context"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

func TestRegistryMutationPersistsSwapsHashRejectsOldTokenAndAudits(t *testing.T) {
	dir := t.TempDir()
	toolPath := filepath.Join(dir, "tools.json")
	rulePath := filepath.Join(dir, "rules.json")
	initialTool := registryTestTool("TEST-TOOL-001", "test.transfer")
	initialRule := registryTestRule("GLOBAL-SAFETY-002")
	writeRegistryFixture(t, toolPath, []coreregistry.Tool{initialTool})
	writeRegistryFixture(t, rulePath, []coreregistry.Rule{initialRule})

	bundle, err := coreregistry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatalf("load registry fixture: %v", err)
	}
	store := repository.NewStore()
	store.Users["admin"] = &models.User{ID: "admin", Name: "Admin", RoleID: repository.RolePlatformAdminID}
	store.Users["client"] = &models.User{ID: "client", Name: "Client", RoleID: repository.RoleClientID}
	validator := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, store)
	spy := &handlerSpyTool{}
	executableTools := tools.NewRegistry(nil)
	executableTools.Register(spy)
	executor := runner.NewExecutor(executableTools, validator, zap.NewNop())
	manager := coreregistry.NewManager(bundle, toolPath, rulePath)
	contextService := generationcontext.NewService(manager, zap.NewNop())
	handler := &Handler{Store: store, Dataset: bundle, RegistryManager: manager, RegistryContext: contextService, RegistryValidator: validator, Runner: executor, Log: zap.NewNop()}

	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		userID := c.Get("X-Test-User")
		if userID == "" {
			userID = "admin"
		}
		c.Locals(middlewares.UserIDKey, userID)
		return c.Next()
	})
	settingsManage := middlewares.RequirePermission("settings:manage", handler.Permissions)
	app.Get("/registry/tools", settingsManage, handler.AdminToolsRegistry)
	app.Post("/registry/tools", settingsManage, handler.CreateRegistryTool)
	app.Post("/registry/rules", settingsManage, handler.CreateRegistryRule)

	yamlText := validWorkflowYAML("25")
	token, result, err := validator.ValidateAndIssueToken("before-registry-change", yamlText, "Platform Admin")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("issue old validation token: result=%+v err=%v", result, err)
	}
	oldHash := validator.RegistryHash()

	newTool := registryTestTool("TEST-TOOL-002", "test.lookup")
	response := registryTestRequest(t, app, http.MethodPost, "/registry/tools", "admin", newTool)
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("create tool returned %d: %s", response.StatusCode, responseBody(t, response))
	}
	response.Body.Close()

	getResponse := registryTestRequest(t, app, http.MethodGet, "/registry/tools", "admin", nil)
	getBody := responseBody(t, getResponse)
	getResponse.Body.Close()
	if !strings.Contains(getBody, newTool.ToolID) {
		t.Fatalf("admin GET did not include new tool: %s", getBody)
	}

	var persisted []coreregistry.Tool
	raw, err := os.ReadFile(toolPath)
	if err != nil {
		t.Fatalf("read persisted registry: %v", err)
	}
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatalf("decode persisted registry: %v", err)
	}
	if len(persisted) != 2 || persisted[1].ToolID != newTool.ToolID {
		t.Fatalf("tool was not persisted: %+v", persisted)
	}
	if validator.RegistryHash() == oldHash {
		t.Fatal("registry hash did not change after mutation")
	}

	_, runErr := executor.Run(context.Background(), "exec-old-token", models.Workflow{ID: "wf", YAML: yamlText}, map[string]interface{}{}, token)
	if runErr == nil || !strings.Contains(runErr.Error(), "registry hash mismatch") {
		t.Fatalf("old token was not rejected after registry mutation: %v", runErr)
	}

	auditFound := false
	for _, entry := range store.AuditLogs {
		if entry.Action == "registry.tool.created" && entry.Resource.ID == newTool.ToolID {
			auditFound = entry.Before["registryHash"] == oldHash && entry.After["registryHash"] == validator.RegistryHash()
		}
	}
	if !auditFound {
		t.Fatal("registry mutation audit entry with old/new hash was not found")
	}

	malformed := json.RawMessage(`{"rule_id":"BAD","unexpected":true}`)
	badResponse := registryTestRequest(t, app, http.MethodPost, "/registry/rules", "admin", malformed)
	if badResponse.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("malformed rule returned %d, want 422", badResponse.StatusCode)
	}
	badResponse.Body.Close()

	forbidden := registryTestRequest(t, app, http.MethodGet, "/registry/tools", "client", nil)
	if forbidden.StatusCode != fiber.StatusForbidden {
		t.Fatalf("client registry GET returned %d, want 403", forbidden.StatusCode)
	}
	forbidden.Body.Close()
}

func TestRegistryCRUDCannotWriteFrozenEvalRegistry(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "configs", "registries")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	toolPath := filepath.Join(dir, "all_tools_master_registry.json")
	rulePath := filepath.Join(dir, "all_rules_master_registry.json")
	writeRegistryFixture(t, toolPath, []coreregistry.Tool{})
	writeRegistryFixture(t, rulePath, []coreregistry.Rule{})
	bundle, err := coreregistry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	store := repository.NewStore()
	store.Users["admin"] = &models.User{ID: "admin", Name: "Admin", RoleID: repository.RolePlatformAdminID}
	handler := &Handler{
		Store: store, Dataset: bundle,
		RegistryManager: coreregistry.NewManager(bundle, toolPath, rulePath),
		Log:             zap.NewNop(),
	}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, "admin")
		return c.Next()
	})
	app.Post("/registry/tools", handler.CreateRegistryTool)
	before, err := os.ReadFile(toolPath)
	if err != nil {
		t.Fatal(err)
	}
	response := registryTestRequest(t, app, http.MethodPost, "/registry/tools", "admin", registryTestTool("TEST-FROZEN-001", "test.frozen.write"))
	if response.StatusCode != fiber.StatusForbidden {
		t.Fatalf("frozen registry CRUD returned %d, want 403: %s", response.StatusCode, responseBody(t, response))
	}
	response.Body.Close()
	after, err := os.ReadFile(toolPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("frozen evaluation registry changed after rejected CRUD request")
	}
}

func registryTestTool(id, name string) coreregistry.Tool {
	return coreregistry.Tool{
		ToolID: id, Name: name, DisplayName: name, Module: "test", Status: "active_mcp_schema_present",
		Description: "Registry test tool", HTTPMethod: http.MethodPost, MCPToolName: name,
		InputSchema: map[string]interface{}{"type": "object"}, AllowedRoles: []string{"Platform Admin"}, RiskLevel: "low", IsReadOnly: true,
	}
}

func registryTestRule(id string) coreregistry.Rule {
	return coreregistry.Rule{
		RuleID: id, RuleName: "No secrets", RuleType: "data_confidentiality", Domain: "global",
		Description: "Reject secrets", Condition: coreregistry.RuleCondition{Type: "sensitive_key", Operator: "not_exists"},
		EnforcementAction: "block", Severity: "critical", ValidatorMessage: "Secrets are not allowed", Enabled: true,
	}
}

func writeRegistryFixture(t *testing.T, path string, value interface{}) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal registry fixture: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write registry fixture: %v", err)
	}
}

func registryTestRequest(t *testing.T, app *fiber.App, method, path, userID string, payload interface{}) *http.Response {
	t.Helper()
	var raw []byte
	if payload != nil {
		var err error
		raw, err = json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal registry request: %v", err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-User", userID)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("registry request failed: %v", err)
	}
	return response
}
