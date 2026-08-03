package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

func testService(t *testing.T, registryTools []coreregistry.Tool, config mockERPConfig) *mockERPService {
	t.Helper()
	service, err := newMockERPService(registryTools, config, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("newMockERPService() error = %v", err)
	}
	return service
}

func activeTool(name string, required ...string) coreregistry.Tool {
	return coreregistry.Tool{
		ToolID: name + "-id", Name: name, MCPToolName: name + "_alias",
		Status: "active_mcp_schema_present", InputSchema: map[string]interface{}{"type": "object"},
		RequiredParameters: required,
	}
}

func postTool(t *testing.T, baseURL, action string, parameters map[string]interface{}) (*http.Response, map[string]interface{}) {
	t.Helper()
	raw, _ := json.Marshal(executeRequest{Action: action, Parameters: parameters})
	request, _ := http.NewRequest(http.MethodPost, baseURL+"/tools/execute", bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("POST tool: %v", err)
	}
	var payload map[string]interface{}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		response.Body.Close()
		t.Fatalf("decode tool response: %v", err)
	}
	response.Body.Close()
	return response, payload
}

func TestMockErpFixtureCountsAndReferences(t *testing.T) {
	state, err := loadFixtureState()
	if err != nil {
		t.Fatalf("loadFixtureState() error = %v", err)
	}
	if len(state.Suppliers) != 20 || len(state.Invoices) != 50 || len(state.PurchaseOrders) != 25 ||
		len(state.Stock) != 30 || len(state.Employees) != 25 || len(state.CostCentres) != 6 {
		t.Fatalf("fixture counts = suppliers:%d invoices:%d purchaseOrders:%d stock:%d employees:%d costCentres:%d",
			len(state.Suppliers), len(state.Invoices), len(state.PurchaseOrders), len(state.Stock), len(state.Employees), len(state.CostCentres))
	}
}

func TestMockErpAcceptsRegistryNameAndMCPAlias(t *testing.T) {
	tool := activeTool("demo.echo", "message")
	service := testService(t, []coreregistry.Tool{tool}, mockERPConfig{})
	server := httptest.NewServer(service)
	defer server.Close()

	for _, action := range []string{tool.Name, tool.MCPToolName} {
		response, payload := postTool(t, server.URL, action, map[string]interface{}{"_action": action, "message": "hello"})
		if response.StatusCode != http.StatusOK || payload["status"] != "success" {
			t.Fatalf("action %s: status=%d payload=%+v", action, response.StatusCode, payload)
		}
	}
}

func TestMockErpRegistersEveryActiveRuntimeTool(t *testing.T) {
	toolsPath := filepath.Join("..", "..", "configs", "runtime", "all_tools_master_registry.json")
	registryTools, err := loadRuntimeTools(toolsPath)
	if err != nil {
		t.Fatalf("loadRuntimeTools(%q) error = %v", toolsPath, err)
	}
	service := testService(t, registryTools, mockERPConfig{})
	activeCount := 0
	for _, tool := range registryTools {
		if !strings.EqualFold(strings.TrimSpace(tool.Status), "active_mcp_schema_present") {
			continue
		}
		activeCount++
		if _, ok := service.toolsByAction[normalizeAction(tool.Name)]; !ok {
			t.Errorf("active registry name %q is not registered", tool.Name)
		}
		if alias := strings.TrimSpace(tool.MCPToolName); alias != "" {
			if _, ok := service.toolsByAction[normalizeAction(alias)]; !ok {
				t.Errorf("active registry alias %q for %q is not registered", alias, tool.Name)
			}
		}
	}
	if len(service.canonicalNames) != activeCount {
		t.Fatalf("service tool count = %d, active runtime registry count = %d", len(service.canonicalNames), activeCount)
	}
}

func TestMockErpMissingRequiredParameterReturns400(t *testing.T) {
	tool := activeTool("demo.echo", "message")
	service := testService(t, []coreregistry.Tool{tool}, mockERPConfig{})
	server := httptest.NewServer(service)
	defer server.Close()
	response, payload := postTool(t, server.URL, tool.Name, map[string]interface{}{"_action": tool.Name})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; payload=%+v", response.StatusCode, payload)
	}
}

func TestMockErpFailureInjectionUsesSettledStatuses(t *testing.T) {
	statuses := map[string]int{"invalid": 400, "auth": 401, "notfound": 404, "transient": 503}
	for mode, want := range statuses {
		t.Run(mode, func(t *testing.T) {
			tool := activeTool("demo.echo", "message")
			service := testService(t, []coreregistry.Tool{tool}, mockERPConfig{FailTool: tool.Name, FailMode: mode})
			server := httptest.NewServer(service)
			defer server.Close()
			response, _ := postTool(t, server.URL, tool.Name, map[string]interface{}{"_action": tool.Name, "message": "hello"})
			if response.StatusCode != want {
				t.Fatalf("status = %d, want %d", response.StatusCode, want)
			}
		})
	}
}

func TestMockErpWriteStateIsVisibleAndResettable(t *testing.T) {
	tool := activeTool("procurement.create_purchase_order", "vendor_id", "item_id", "quantity")
	service := testService(t, []coreregistry.Tool{tool}, mockERPConfig{})
	server := httptest.NewServer(service)
	defer server.Close()
	parameters := map[string]interface{}{"_action": tool.Name, "vendor_id": "SUP-001", "item_id": "SKU-001", "quantity": float64(2)}
	first, payload := postTool(t, server.URL, tool.Name, parameters)
	if first.StatusCode != http.StatusOK || payload["created"] != true {
		t.Fatalf("first create status=%d payload=%+v", first.StatusCode, payload)
	}
	second, payload := postTool(t, server.URL, tool.Name, parameters)
	if second.StatusCode != http.StatusOK || payload["created"] != false {
		t.Fatalf("second create status=%d payload=%+v", second.StatusCode, payload)
	}
	resetRequest, _ := http.NewRequest(http.MethodPost, server.URL+"/reset", nil)
	resetResponse, err := http.DefaultClient.Do(resetRequest)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	resetResponse.Body.Close()
	third, payload := postTool(t, server.URL, tool.Name, parameters)
	if third.StatusCode != http.StatusOK || payload["created"] != true {
		t.Fatalf("post-reset create status=%d payload=%+v", third.StatusCode, payload)
	}
}

func TestMockErpNeverReachedByPolicyBlockedStep(t *testing.T) {
	safeTool := coreregistry.Tool{
		ToolID: "SAFE", Name: "demo.echo", MCPToolName: "demo.echo", Module: "demo",
		Status: "active_mcp_schema_present", InputSchema: map[string]interface{}{
			"type": "object", "required": []interface{}{"message", "amount"},
			"properties": map[string]interface{}{
				"message": map[string]interface{}{"type": "string"},
				"amount":  map[string]interface{}{"type": "number"},
			},
		},
		RequiredParameters: []string{"message", "amount"}, RiskLevel: "low",
	}
	blockedTool := coreregistry.Tool{
		ToolID: "CLEAR", Name: "finance.clear_invoice", MCPToolName: "finance.clear_invoice", Module: "finance",
		Status: "active_mcp_schema_present", InputSchema: map[string]interface{}{"type": "object"},
		RequiredParameters: []string{"invoice_id"}, RiskLevel: "high",
	}
	service := testService(t, []coreregistry.Tool{safeTool, blockedTool}, mockERPConfig{})
	server := httptest.NewServer(service)
	defer server.Close()

	store := repository.NewStore()
	toolRegistry := coreregistry.NewToolRegistry([]coreregistry.Tool{safeTool, blockedTool}, "tools-v1")
	ruleRegistry := coreregistry.NewRuleRegistry([]coreregistry.Rule{{
		RuleID: "MOCK-THRESHOLD", RuleName: "Runtime amount limit", RuleType: "amount_threshold", Domain: "finance",
		AppliesToTools: []string{blockedTool.Name}, Condition: coreregistry.RuleCondition{
			Type: "amount_threshold", Parameter: "amount", Operator: ">", Value: float64(100),
		},
		EnforcementAction: "block", Severity: "high", ValidatorMessage: "Amount exceeds 100.", Enabled: true,
	}}, "rules-v1")
	registryValidator := workflowvalidator.NewRegistryValidator(toolRegistry, ruleRegistry, store)
	mcpClient := tools.NewMCPClient(server.URL, time.Second)
	executable := tools.NewRegistry(nil)
	executable.Register(tools.GenericMCPTool{Action: safeTool.Name, Client: mcpClient})
	executable.Register(tools.GenericMCPTool{Action: blockedTool.Name, Client: mcpClient})
	executor := runner.NewExecutor(executable, registryValidator, zap.NewNop())

	yamlText := "name: mock_erp_boundary\n" +
		"description: Proves a blocked second step never reaches the downstream service.\n" +
		"trigger:\n  type: manual\n" +
		"steps:\n" +
		"  - id: first\n    action: demo.echo\n    parameters:\n      message: hello\n      amount: 1\n" +
		"  - id: blocked\n    action: finance.clear_invoice\n    parameters:\n      invoice_id: INV-001\n      amount: '{{input.amount}}'\n"
	token, validation, err := registryValidator.ValidateAndIssueToken("mock-erp-boundary", yamlText, "Platform Admin")
	if err != nil || token == nil || !validation.Passed {
		t.Fatalf("plan validation failed: err=%v validation=%+v", err, validation)
	}
	workflow := models.Workflow{ID: "wf-boundary", Name: "Mock ERP boundary", YAML: yamlText}
	_, runErr := executor.Run(context.Background(), "exec-boundary", workflow, map[string]interface{}{"amount": float64(150)}, token)
	if runErr == nil || !strings.Contains(runErr.Error(), "dispatch policy violation") {
		t.Fatalf("Run() error = %v, want dispatch policy violation", runErr)
	}
	requests := service.Requests()
	if len(requests) != 1 {
		t.Fatalf("mock ERP request count = %d, want exactly first step; requests=%+v", len(requests), requests)
	}
	if requests[0].CanonicalAction != safeTool.Name {
		t.Fatalf("mock ERP received action %q, want only %q", requests[0].CanonicalAction, safeTool.Name)
	}
	for _, request := range requests {
		if request.CanonicalAction == blockedTool.Name {
			t.Fatalf("policy-blocked action reached mock ERP: %+v", request)
		}
	}
}
