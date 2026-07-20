package integration

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/handlers"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/routes"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

const demoWorkflowYAML = `name: governed_demo_echo
description: Echo a client message through the deterministic governed demo path.
trigger:
  type: manual
  displayName: Manual demo
steps:
  - id: echo
    action: demo.echo
    description: Echo the supplied demo payload.
    parameters:
      message: "{{input.message}}"
      amount: "{{input.amount}}"
`

func TestGovernedDemoFlowThroughRealRoutes(t *testing.T) {
	app := newGovernedDemoApp(t)

	adminSession, _ := demoJSON[demoAuthSession](t, app, http.MethodPost, "/api/auth/register", "", map[string]interface{}{
		"name": "Demo Admin", "email": "admin@demo.test", "password": "admin-password",
	}, http.StatusCreated)
	if adminSession.User.Role != "Platform Admin" {
		t.Fatalf("first registered account must bootstrap Platform Admin, got %q", adminSession.User.Role)
	}

	const fakeGeminiKey = "demo-gemini-key-not-real"
	provider, providerBody := demoJSON[demoProvider](t, app, http.MethodPost, "/api/providers", adminSession.AccessToken, map[string]interface{}{
		"name": "Demo Gemini", "type": "gemini", "model": "gemini-2.5-flash", "apiKey": fakeGeminiKey,
	}, http.StatusCreated)
	if !provider.Active || provider.Type != "gemini" || provider.Model != "gemini-2.5-flash" {
		t.Fatalf("unexpected provider response: %+v", provider)
	}
	if bytes.Contains(providerBody, []byte(fakeGeminiKey)) {
		t.Fatal("provider API echoed the write-only Gemini credential")
	}

	builder, _ := demoJSON[models.User](t, app, http.MethodPost, "/api/users", adminSession.AccessToken, map[string]interface{}{
		"name": "Demo Builder", "email": "builder@demo.test", "password": "builder-password", "roleId": "role_builder",
	}, http.StatusCreated)
	client, _ := demoJSON[models.User](t, app, http.MethodPost, "/api/users", adminSession.AccessToken, map[string]interface{}{
		"name": "Demo Client", "email": "client@demo.test", "password": "client-password", "roleId": "role_client",
	}, http.StatusCreated)
	if builder.Role.ID != "role_builder" || client.Role.ID != "role_client" {
		t.Fatalf("unexpected demo user roles: builder=%q client=%q", builder.Role.ID, client.Role.ID)
	}

	demoJSON[map[string]interface{}](t, app, http.MethodPost, "/api/registry/rules", adminSession.AccessToken, demoAmountRule(), http.StatusCreated)

	builderSession, _ := demoJSON[demoAuthSession](t, app, http.MethodPost, "/api/auth/login", "", map[string]interface{}{
		"email": "builder@demo.test", "password": "builder-password",
	}, http.StatusOK)
	workflow, _ := demoJSON[models.Workflow](t, app, http.MethodPost, "/api/workflows", builderSession.AccessToken, map[string]interface{}{
		"name": "Governed Demo Echo", "description": "Client-runnable mock MCP and dispatch-policy demo.", "yaml": demoWorkflowYAML,
	}, http.StatusCreated)
	if workflow.ID == "" || workflow.Steps != 1 {
		t.Fatalf("unexpected workflow response: %+v", workflow)
	}
	demoJSON[models.Workflow](t, app, http.MethodPost, "/api/workflows/"+workflow.ID+"/assign", builderSession.AccessToken, map[string]interface{}{
		"userId": client.ID,
	}, http.StatusOK)

	clientSession, _ := demoJSON[demoAuthSession](t, app, http.MethodPost, "/api/auth/login", "", map[string]interface{}{
		"email": "client@demo.test", "password": "client-password",
	}, http.StatusOK)
	assigned, _ := demoJSON[[]models.Workflow](t, app, http.MethodGet, "/api/workflows", clientSession.AccessToken, nil, http.StatusOK)
	if len(assigned) != 1 || assigned[0].ID != workflow.ID {
		t.Fatalf("client workflow list was not assignment-scoped: %+v", assigned)
	}

	safeExecution, _ := demoJSON[models.Execution](t, app, http.MethodPost, "/api/workflows/"+workflow.ID+"/run", clientSession.AccessToken, map[string]interface{}{
		"input": map[string]interface{}{"message": "hello from the client portal", "amount": 25},
	}, http.StatusOK)
	if safeExecution.Status != models.StatusDone {
		t.Fatalf("safe mock execution did not finish: %+v", safeExecution)
	}
	safeLogs, _ := demoJSON[[]models.ExecutionLog](t, app, http.MethodGet, "/api/executions/"+safeExecution.ID+"/logs", clientSession.AccessToken, nil, http.StatusOK)
	if len(safeLogs) != 1 || safeLogs[0].Metadata["mock"] != true || safeLogs[0].Metadata["action"] != "demo.echo" {
		t.Fatalf("safe execution did not use deterministic demo MCP: %+v", safeLogs)
	}

	unsafeExecution, _ := demoJSON[models.Execution](t, app, http.MethodPost, "/api/workflows/"+workflow.ID+"/run", clientSession.AccessToken, map[string]interface{}{
		"input": map[string]interface{}{"message": "this call must never reach the tool", "amount": 125},
	}, http.StatusOK)
	if unsafeExecution.Status != models.StatusFailed {
		t.Fatalf("policy-unsafe execution was not blocked: %+v", unsafeExecution)
	}
	unsafeLogs, _ := demoJSON[[]models.ExecutionLog](t, app, http.MethodGet, "/api/executions/"+unsafeExecution.ID+"/logs", clientSession.AccessToken, nil, http.StatusOK)
	if len(unsafeLogs) != 1 || unsafeLogs[0].Metadata["rule_id"] != "DEMO-AMOUNT-001" {
		t.Fatalf("unsafe execution did not retain policy evidence: %+v", unsafeLogs)
	}
	if strings.Contains(unsafeLogs[0].Message, "demo.echo executed") {
		t.Fatalf("unsafe execution reached the tool: %+v", unsafeLogs[0])
	}
}

type demoAuthSession struct {
	AccessToken string `json:"accessToken"`
	User        struct {
		ID   string `json:"id"`
		Role string `json:"role"`
	} `json:"user"`
}

type demoProvider struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Model      string `json:"model"`
	KeyPreview string `json:"keyPreview"`
	Active     bool   `json:"active"`
}

type demoEnvelope[T any] struct {
	Success bool   `json:"success"`
	Data    T      `json:"data"`
	Message string `json:"message"`
}

func demoJSON[T any](t *testing.T, app *fiber.App, method, path, token string, body interface{}, expectedStatus int) (T, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode %s %s request: %v", method, path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s %s response: %v", method, path, err)
	}
	if resp.StatusCode != expectedStatus {
		t.Fatalf("%s %s: expected %d, got %d: %s", method, path, expectedStatus, resp.StatusCode, raw)
	}
	var payload demoEnvelope[T]
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode %s %s response: %v: %s", method, path, err, raw)
	}
	if !payload.Success {
		t.Fatalf("%s %s returned unsuccessful envelope: %s", method, path, raw)
	}
	return payload.Data, raw
}

func newGovernedDemoApp(t *testing.T) *fiber.App {
	t.Helper()
	toolPath, rulePath := copyDemoRegistryFiles(t)
	bundle, err := coreregistry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatalf("load temporary demo registries: %v", err)
	}
	if tool, ok := bundle.Tools.FindToolByName("demo.echo"); !ok || !tool.IsReadOnly {
		t.Fatal("demo.echo must be present as a read-only registered tool")
	}

	cfg := config.Config{
		AppName: "governed-demo-test", APIBasePath: "/api", Environment: "test",
		JWTSecret: "demo-test-jwt-secret", TokenTTL: time.Hour,
		ToolRegistryPath: toolPath, RuleRegistryPath: rulePath,
	}
	store := repository.NewStore()
	validator := workflowvalidator.NewWorkflowValidator()
	registryValidator := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, store)
	mcp := tools.NewMCPClient("", time.Second)
	if err := mcp.SetMode("mock"); err != nil {
		t.Fatalf("enable explicit MCP mock mode: %v", err)
	}
	toolRegistry := tools.NewRegistry(nil)
	for _, definition := range bundle.Tools.GetAllTools() {
		toolRegistry.Register(tools.GenericMCPTool{Action: definition.Name, Client: mcp})
	}
	executor := runner.NewExecutor(toolRegistry, registryValidator, zap.NewNop())
	synth := synthesizer.NewServiceWithProvider("", "", false, "gemini", "", "gemini-2.5-flash")
	handler := handlers.New(cfg, store, synth, validator, bundle, registryValidator, nil, nil, executor, healing.NewHealer(synth), zap.NewNop())
	handler.RegistryManager.SetToolUpsert(func(definition coreregistry.Tool) {
		if !toolRegistry.Has(definition.Name) {
			toolRegistry.Register(tools.GenericMCPTool{Action: definition.Name, Client: mcp})
		}
	})

	app := fiber.New(fiber.Config{ErrorHandler: func(c *fiber.Ctx, requestErr error) error {
		code := fiber.StatusInternalServerError
		message := "Internal server error"
		if fiberErr, ok := requestErr.(*fiber.Error); ok {
			code = fiberErr.Code
			message = fiberErr.Message
		}
		return c.Status(code).JSON(models.Fail(message, nil))
	}})
	routes.Register(app, handler)
	t.Cleanup(func() { _ = app.Shutdown() })
	return app
}

func copyDemoRegistryFiles(t *testing.T) (string, string) {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve demo integration test path")
	}
	backendRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	tempRoot := t.TempDir()
	copyOne := func(name string) string {
		source := filepath.Join(backendRoot, "configs", "registries", name)
		raw, err := os.ReadFile(source)
		if err != nil {
			t.Fatalf("read registry fixture %s: %v", source, err)
		}
		destination := filepath.Join(tempRoot, name)
		if err := os.WriteFile(destination, raw, 0o600); err != nil {
			t.Fatalf("copy registry fixture %s: %v", name, err)
		}
		return destination
	}
	return copyOne("all_tools_master_registry.json"), copyOne("all_rules_master_registry.json")
}

func demoAmountRule() map[string]interface{} {
	return map[string]interface{}{
		"rule_id": "DEMO-AMOUNT-001", "rule_name": "Block unsafe demo amounts", "rule_type": "amount_threshold",
		"domain": "demo", "description": "Block the demo echo before dispatch when amount exceeds 100.",
		"applies_to_tools": []string{"demo.echo"}, "applies_to_roles": []string{},
		"condition":          map[string]interface{}{"type": "numeric_threshold", "parameter": "amount", "operator": ">", "value": 100},
		"enforcement_action": "block", "severity": "high", "validator_message": "Demo amount exceeds the allowed maximum of 100.",
		"llm_prompt_instruction": "Keep demo.echo amount at or below 100.", "healing_guidance": "Lower amount to 100 or less.",
		"bpi_alignment": []string{}, "audit_fields_required": []string{}, "enabled": true,
	}
}
