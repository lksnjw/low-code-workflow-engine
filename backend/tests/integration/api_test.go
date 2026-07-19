package integration

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/handlers"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/routes"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

func TestChatEndpointWithMockEmbeddingSearchAndGemini(t *testing.T) {
	bundle := loadConfigBundle(t)
	toolNames := []string{
		"policy.check_policy_limit",
		"procurement.validate_vendor",
		"procurement.create_purchase_order",
		"approval.request_human_approval",
		"audit.write_audit_log",
	}
	toolsForPrompt := []coreregistry.Tool{}
	for _, name := range toolNames {
		tool, ok := bundle.Tools.FindToolByName(name)
		if !ok {
			t.Fatalf("missing fixture tool %s", name)
		}
		toolsForPrompt = append(toolsForPrompt, tool)
	}

	searchServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		toolItems := []map[string]interface{}{}
		for _, tool := range toolsForPrompt {
			toolItems = append(toolItems, map[string]interface{}{
				"id":           tool.ToolID,
				"name":         tool.Name,
				"score":        0.95,
				"match_reason": "mock embedding match",
				"source_file":  "fixture",
				"original":     tool,
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"query":            "Create a purchase order",
			"retrieval_method": "embedding_faiss_all-MiniLM-L6-v2",
			"tools":            toolItems,
			"rules":            []map[string]interface{}{},
			"templates":        []map[string]interface{}{},
			"examples":         []map[string]interface{}{},
		})
	}))
	defer searchServer.Close()

	geminiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		text := `--- candidate_1 ---
name: purchase_order_approval
description: Create purchase order with policy check, approval, and audit.
trigger:
  type: manual
  displayName: Manual Trigger
  config: {}
steps:
  - id: policy
    action: policy.check_policy_limit
    description: Check procurement policy threshold.
    parameters:
      policy_domain: procurement
      quantity: 150
    retryCount: 1
    onError: stop
  - id: vendor
    action: procurement.validate_vendor
    description: Validate vendor before PO creation.
    parameters:
      vendor_id: V-882
    retryCount: 1
    onError: stop
  - id: create_po
    action: procurement.create_purchase_order
    description: Create purchase order.
    parameters:
      vendor_id: V-882
      item_id: laptops
      quantity: 150
    retryCount: 1
    onError: stop
  - id: approval
    action: approval.request_human_approval
    description: Request approval for high quantity.
    parameters:
      approval_reason: High quantity purchase
      approver_role: procurement_manager
    retryCount: 1
    onError: stop
  - id: audit
    action: audit.write_audit_log
    description: Write audit evidence.
    parameters:
      event_type: purchase_order_created
      actor_role: Workflow Builder
      decision: queued_for_approval
    retryCount: 1
    onError: stop

--- candidate_2 ---
name: bad_purchase_order
description: Missing vendor.
trigger:
  type: manual
steps:
  - id: create_po
    action: procurement.create_purchase_order
    parameters:
      item_id: laptops
      quantity: 150
`
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{
				{"content": map[string]interface{}{"parts": []map[string]interface{}{{"text": text}}}},
			},
		})
	}))
	defer geminiServer.Close()

	cfg := config.Config{
		AppName:                            "test",
		APIBasePath:                        "/api",
		JWTSecret:                          "secret",
		AllowDevAuth:                       true,
		TokenTTL:                           time.Hour,
		SemanticSearchMode:                 "external_embedding",
		SemanticSearchURL:                  searchServer.URL,
		SemanticSearchTopKTools:            10,
		SemanticSearchTopKRules:            15,
		SemanticSearchTopKTemplates:        5,
		SemanticSearchTopKExamples:         5,
		SemanticSearchAllowLexicalFallback: false,
		CandidateCount:                     3,
		WorkflowGenerationProvider:         "gemini",
		GeminiModel:                        "gemini-test",
		GeminiAPIKey:                       "test-key",
	}
	store := repository.NewStore()
	synth := synthesizer.NewServiceWithProvider("", "", false, "gemini", "test-key", "gemini-test")
	synth.Gemini.BaseURL = geminiServer.URL
	validator := workflowvalidator.NewWorkflowValidator()
	registryValidator := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, store)
	search := semanticsearch.NewServiceFromDataset(bundle, cfg.SemanticSearchMode, cfg.SemanticSearchURL, cfg.SemanticSearchAllowLexicalFallback)
	orch := orchestrator.NewChatOrchestrator(search, synth, registryValidator)
	exec := runner.NewExecutor(tools.NewRegistry(nil), registryValidator, zap.NewNop())
	healer := healing.NewHealer(synth)
	handler := handlers.New(cfg, store, synth, validator, bundle, registryValidator, search, orch, exec, healer, zap.NewNop())

	app := fiber.New()
	routes.Register(app, handler)
	registrationBody, _ := json.Marshal(map[string]interface{}{
		"name": "Integration Admin", "email": "integration@example.test", "password": "correct-horse-battery-staple",
	})
	registrationRequest := httptest.NewRequest(http.MethodPost, "/api/auth/register", bytes.NewReader(registrationBody))
	registrationRequest.Header.Set("Content-Type", "application/json")
	registrationResponse, err := app.Test(registrationRequest)
	if err != nil || registrationResponse.StatusCode != http.StatusCreated {
		t.Fatalf("register test user: status=%d err=%v", registrationResponse.StatusCode, err)
	}
	var registrationPayload struct {
		Data struct {
			AccessToken string `json:"accessToken"`
		} `json:"data"`
	}
	if err := json.NewDecoder(registrationResponse.Body).Decode(&registrationPayload); err != nil || registrationPayload.Data.AccessToken == "" {
		t.Fatalf("decode registration session: %v", err)
	}

	body, _ := json.Marshal(map[string]interface{}{
		"content":             "Create a purchase order for 150 laptops from vendor V-882 and send it for approval.",
		"mode":                "generate_workflow",
		"generate_candidates": "3",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/chat/sessions/chat_test/messages", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+registrationPayload.Data.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app test failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var payload struct {
		Success bool `json:"success"`
		Data    struct {
			CanExecute           bool   `json:"can_execute"`
			SelectedCandidateID  string `json:"selected_candidate_id"`
			SelectedWorkflowYAML string `json:"selected_workflow_yaml"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.Success || !payload.Data.CanExecute {
		t.Fatalf("expected executable selected candidate, got %+v", payload)
	}
	if payload.Data.SelectedCandidateID != "candidate_1" || payload.Data.SelectedWorkflowYAML == "" {
		t.Fatalf("expected candidate_1 selected, got %+v", payload.Data)
	}
}

func loadConfigBundle(t *testing.T) *coreregistry.Bundle {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve test path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	bundle, err := coreregistry.LoadBundle(
		filepath.Join(root, "configs", "registries", "all_tools_master_registry.json"),
		filepath.Join(root, "configs", "registries", "all_rules_master_registry.json"),
		zap.NewNop(),
	)
	if err != nil {
		t.Fatalf("load fixture bundle: %v", err)
	}
	return bundle
}
