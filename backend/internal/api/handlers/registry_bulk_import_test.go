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

func TestBulkToolImportAppliesAtomicallyPersistsAndChangesHash(t *testing.T) {
	fixture := newBulkRegistryFixture(t)
	oldHash := fixture.manager.Hash()
	batch := []coreregistry.Tool{
		registryTestTool("TEST-TOOL-002", "test.lookup"),
		registryTestTool("TEST-TOOL-003", "test.notify"),
	}
	response := bulkRegistryRequest(t, fixture.app, "/registry/tools/import", batch)
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("bulk tool import returned %d: %s", response.StatusCode, responseBody(t, response))
	}
	body := responseBody(t, response)
	response.Body.Close()
	if !strings.Contains(body, `"count":2`) || !strings.Contains(body, `"applied":true`) {
		t.Fatalf("bulk result did not report two applied tools: %s", body)
	}

	getResponse := registryTestRequest(t, fixture.app, http.MethodGet, "/registry/tools", "admin", nil)
	getBody := responseBody(t, getResponse)
	getResponse.Body.Close()
	for _, tool := range batch {
		if !strings.Contains(getBody, tool.ToolID) {
			t.Fatalf("GET omitted imported tool %s: %s", tool.ToolID, getBody)
		}
	}
	var persisted []coreregistry.Tool
	decodeRegistryFile(t, fixture.toolPath, &persisted)
	if len(persisted) != 3 {
		t.Fatalf("persisted tool count=%d, want 3", len(persisted))
	}
	if fixture.manager.Hash() == oldHash {
		t.Fatal("bulk tool import did not change the registry hash")
	}

	contextPath := filepath.Join(filepath.Dir(fixture.toolPath), "registry_context.md")
	contextMarkdown, err := os.ReadFile(contextPath)
	if err != nil {
		t.Fatalf("read regenerated context: %v", err)
	}
	for _, tool := range batch {
		if !bytes.Contains(contextMarkdown, []byte(tool.Name)) {
			t.Fatalf("generated context omitted imported tool %s", tool.Name)
		}
	}
	if !bytes.Contains(contextMarkdown, []byte("<!-- registry_sha256: "+fixture.manager.Hash()+" -->")) {
		t.Fatalf("generated context header omitted current registry hash %s", fixture.manager.Hash())
	}

	foundAudit := false
	for _, entry := range fixture.store.AuditLogs {
		if entry.Action == "registry.tools.imported" {
			ids, _ := entry.After["ids"].([]string)
			foundAudit = entry.Actor.ID == "admin" && entry.Before["registryHash"] == oldHash &&
				entry.After["registryHash"] == fixture.manager.Hash() && entry.After["count"] == 2 &&
				len(ids) == 2 && ids[0] == batch[0].ToolID && ids[1] == batch[1].ToolID
		}
	}
	if !foundAudit {
		t.Fatal("bulk import audit with actor, count, and new hash was not found")
	}
}

func TestBulkToolImportMalformedEntryAppliesNothingAndReportsIndex(t *testing.T) {
	fixture := newBulkRegistryFixture(t)
	beforeFile, err := os.ReadFile(fixture.toolPath)
	if err != nil {
		t.Fatal(err)
	}
	beforeHash := fixture.manager.Hash()
	raw := []byte(`[
		{"tool_id":"TEST-TOOL-002","name":"test.lookup","display_name":"Lookup","module":"test","status":"active_mcp_schema_present","description":"Lookup","http_method":"POST","mcp_tool_name":"test.lookup","input_schema":{"type":"object"}},
		{"tool_id":"BAD-TOOL","unexpected":true}
	]`)
	response := bulkRegistryRawRequest(t, fixture.app, "/registry/tools/import", raw)
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("malformed batch returned %d: %s", response.StatusCode, responseBody(t, response))
	}
	body := responseBody(t, response)
	response.Body.Close()
	if !strings.Contains(body, `"index":1`) || !strings.Contains(body, `"id":"BAD-TOOL"`) || strings.Count(body, `"index":`) != 1 {
		t.Fatalf("malformed batch did not report exactly entry 1/BAD-TOOL: %s", body)
	}
	afterFile, err := os.ReadFile(fixture.toolPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforeFile, afterFile) || fixture.manager.Hash() != beforeHash || len(fixture.manager.Tools()) != 1 {
		t.Fatal("malformed batch changed the durable file, live snapshot, or hash")
	}
}

func TestBulkImportRejectsDuplicateAndExistingIDs(t *testing.T) {
	t.Run("within batch", func(t *testing.T) {
		fixture := newBulkRegistryFixture(t)
		duplicate := []coreregistry.Tool{
			registryTestTool("TEST-TOOL-002", "test.lookup"),
			registryTestTool("test-tool-002", "test.notify"),
		}
		response := bulkRegistryRequest(t, fixture.app, "/registry/tools/import", duplicate)
		if response.StatusCode != fiber.StatusUnprocessableEntity {
			t.Fatalf("duplicate batch returned %d: %s", response.StatusCode, responseBody(t, response))
		}
		body := responseBody(t, response)
		response.Body.Close()
		if !strings.Contains(body, "duplicated in the batch") || len(fixture.manager.Tools()) != 1 {
			t.Fatalf("duplicate batch was not rejected atomically: %s", body)
		}
	})

	t.Run("against existing", func(t *testing.T) {
		fixture := newBulkRegistryFixture(t)
		response := bulkRegistryRequest(t, fixture.app, "/registry/tools/import", []coreregistry.Tool{registryTestTool("TEST-TOOL-001", "test.transfer")})
		if response.StatusCode != fiber.StatusUnprocessableEntity {
			t.Fatalf("existing collision returned %d: %s", response.StatusCode, responseBody(t, response))
		}
		body := responseBody(t, response)
		response.Body.Close()
		if !strings.Contains(body, "already exists") || len(fixture.manager.Tools()) != 1 {
			t.Fatalf("existing collision was not rejected: %s", body)
		}
	})
}

func TestBulkImportUpdatesOnlyWhenExplicitlyMarked(t *testing.T) {
	fixture := newBulkRegistryFixture(t)
	updated := registryTestTool("TEST-TOOL-001", "test.transfer")
	updated.Description = "Updated through an explicitly marked bulk request"
	raw, err := json.Marshal([]coreregistry.Tool{updated})
	if err != nil {
		t.Fatal(err)
	}
	response := bulkRegistryRawRequest(t, fixture.app, "/registry/tools/import?allowUpdates=true", raw)
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("explicit bulk update returned %d: %s", response.StatusCode, responseBody(t, response))
	}
	response.Body.Close()
	if len(fixture.manager.Tools()) != 1 || fixture.manager.Tools()[0].Description != updated.Description {
		t.Fatal("explicit bulk update was not applied as one replacement")
	}
}

func TestBulkRuleImportAppliesAtomically(t *testing.T) {
	fixture := newBulkRegistryFixture(t)
	batch := []coreregistry.Rule{
		registryTestRule("GLOBAL-SAFETY-003"),
		registryTestRule("GLOBAL-SAFETY-004"),
	}
	response := bulkRegistryRequest(t, fixture.app, "/registry/rules/import", batch)
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("bulk rule import returned %d: %s", response.StatusCode, responseBody(t, response))
	}
	response.Body.Close()
	var persisted []coreregistry.Rule
	decodeRegistryFile(t, fixture.rulePath, &persisted)
	if len(persisted) != 3 || len(fixture.manager.Rules()) != 3 {
		t.Fatalf("rule batch was not published and persisted together: persisted=%d live=%d", len(persisted), len(fixture.manager.Rules()))
	}
}

func TestOldValidationTokenRejectedAfterBulkImport(t *testing.T) {
	fixture := newBulkRegistryFixture(t)
	yamlText := validWorkflowYAML("25")
	token, result, err := fixture.validator.ValidateAndIssueToken("before-bulk-import", yamlText, "Platform Admin")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("issue validation token: result=%+v err=%v", result, err)
	}
	response := bulkRegistryRequest(t, fixture.app, "/registry/tools/import", []coreregistry.Tool{registryTestTool("TEST-TOOL-002", "test.lookup")})
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("bulk import returned %d: %s", response.StatusCode, responseBody(t, response))
	}
	response.Body.Close()
	_, runErr := fixture.executor.Run(context.Background(), "exec-old-bulk-token", models.Workflow{ID: "wf", YAML: yamlText}, map[string]interface{}{}, token)
	if runErr == nil || !strings.Contains(runErr.Error(), "registry hash mismatch") {
		t.Fatalf("old token was not rejected after bulk import: %v", runErr)
	}
}

type bulkRegistryFixture struct {
	app       *fiber.App
	manager   *coreregistry.Manager
	validator *workflowvalidator.RegistryValidator
	executor  *runner.Executor
	store     *repository.Store
	toolPath  string
	rulePath  string
}

func newBulkRegistryFixture(t *testing.T) bulkRegistryFixture {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "configs", "runtime")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	toolPath := filepath.Join(dir, "all_tools_master_registry.json")
	rulePath := filepath.Join(dir, "all_rules_master_registry.json")
	writeRegistryFixture(t, toolPath, []coreregistry.Tool{registryTestTool("TEST-TOOL-001", "test.transfer")})
	writeRegistryFixture(t, rulePath, []coreregistry.Rule{registryTestRule("GLOBAL-SAFETY-002")})
	bundle, err := coreregistry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	store := repository.NewStore()
	store.Users["admin"] = &models.User{ID: "admin", Name: "Admin", RoleID: repository.RolePlatformAdminID}
	manager := coreregistry.NewManager(bundle, toolPath, rulePath)
	contextService := generationcontext.NewService(manager, zap.NewNop())
	validator := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, store)
	executableTools := tools.NewRegistry(nil)
	executableTools.Register(&handlerSpyTool{})
	executor := runner.NewExecutor(executableTools, validator, zap.NewNop())
	handler := &Handler{
		Store: store, Dataset: bundle, RegistryManager: manager, RegistryContext: contextService,
		RegistryValidator: validator, Runner: executor, Log: zap.NewNop(),
	}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, "admin")
		return c.Next()
	})
	settingsManage := middlewares.RequirePermission("settings:manage", handler.Permissions)
	app.Get("/registry/tools", settingsManage, handler.AdminToolsRegistry)
	app.Post("/registry/tools/import", settingsManage, handler.ImportRegistryTools)
	app.Post("/registry/rules/import", settingsManage, handler.ImportRegistryRules)
	return bulkRegistryFixture{app: app, manager: manager, validator: validator, executor: executor, store: store, toolPath: toolPath, rulePath: rulePath}
}

func bulkRegistryRequest(t *testing.T, app *fiber.App, path string, payload interface{}) *http.Response {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return bulkRegistryRawRequest(t, app, path, raw)
}

func bulkRegistryRawRequest(t *testing.T, app *fiber.App, path string, raw []byte) *http.Response {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func decodeRegistryFile(t *testing.T, path string, target interface{}) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatal(err)
	}
}
