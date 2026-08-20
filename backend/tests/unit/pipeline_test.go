package unit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

func TestDatasetLoaderLoadsToolsRulesTemplatesAndExamples(t *testing.T) {
	bundle := loadDatasetFixture(t)
	if len(bundle.Tools.GetAllTools()) == 0 {
		t.Fatal("expected dataset tools")
	}
	if len(bundle.Rules.GetAllRules()) == 0 {
		t.Fatal("expected dataset rules")
	}
	if len(bundle.Templates) == 0 {
		t.Fatal("expected dataset process templates")
	}
	if len(bundle.Examples) == 0 {
		t.Fatal("expected dataset scenario examples")
	}
}

func TestSemanticSearchRetrievesProcurementTools(t *testing.T) {
	bundle := loadRegistryFixture(t)
	search := semanticsearch.NewService(bundle.Tools, bundle.Rules, "go_lexical")

	result, err := search.SearchContext(context.Background(), "Create a purchase order for 150 laptops from vendor V-882 and send it for approval.", "Workflow Builder", semanticsearch.Options{TopKTools: 10, TopKRules: 15})
	if err != nil {
		t.Fatalf("semantic search returned error: %v", err)
	}

	for _, expected := range []string{"procurement.create_purchase_order", "approval.request_human_approval", "policy.check_policy_limit"} {
		if !hasTool(result.Tools, expected) {
			t.Fatalf("expected retrieved tool %s, got %#v", expected, toolNames(result.Tools))
		}
	}
	if len(result.GlobalRules) == 0 {
		t.Fatal("expected global safety rules to be included")
	}
}

func TestExternalSemanticSearchClientUsesMockEmbeddingService(t *testing.T) {
	bundle := loadRegistryFixture(t)
	createPO, _ := bundle.Tools.FindToolByName("procurement.create_purchase_order")
	rule := bundle.Rules.GetAllRules()[0]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["query"] == "" {
			t.Fatal("expected query in semantic search request")
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"query":            req["query"],
			"retrieval_method": "embedding_faiss_all-MiniLM-L6-v2",
			"tools": []map[string]interface{}{{
				"id":           createPO.ToolID,
				"name":         createPO.Name,
				"score":        0.91,
				"match_reason": "mock embedding hit",
				"original":     createPO,
			}},
			"rules": []map[string]interface{}{{
				"id":           rule.RuleID,
				"rule_id":      rule.RuleID,
				"rule_name":    rule.RuleName,
				"score":        0.88,
				"match_reason": "mock rule hit",
				"original":     rule,
			}},
			"templates": []map[string]interface{}{},
			"examples":  []map[string]interface{}{},
		})
	}))
	defer server.Close()

	search := semanticsearch.NewServiceFromDataset(&coreregistry.Bundle{Tools: bundle.Tools, Rules: bundle.Rules}, "external_embedding", server.URL, false)
	result, err := search.SearchContext(context.Background(), "Create a purchase order", "Workflow Builder", semanticsearch.Options{TopKTools: 3, TopKRules: 3})
	if err != nil {
		t.Fatalf("external semantic search returned error: %v", err)
	}
	if result.RetrievalMethod != "embedding_faiss_all-MiniLM-L6-v2" {
		t.Fatalf("expected embedding method, got %s", result.RetrievalMethod)
	}
	if !hasTool(result.Tools, "procurement.create_purchase_order") {
		t.Fatalf("expected procurement.create_purchase_order, got %#v", toolNames(result.Tools))
	}
}

func TestPromptBuilderIncludesRetrievedContextAndExamples(t *testing.T) {
	bundle := loadRegistryFixture(t)
	tool, _ := bundle.Tools.FindToolByName("procurement.create_purchase_order")
	rule := bundle.Rules.GetAllRules()[0]
	prompt := synthesizer.NewPromptBuilder().BuildCandidatePrompt(synthesizer.CandidateGenerationRequest{
		Prompt:         "Create a purchase order",
		UserRole:       "Workflow Builder",
		CandidateCount: 3,
		Tools:          []coreregistry.Tool{tool},
		Rules:          []coreregistry.Rule{rule},
		Examples: []coreregistry.FewShotExample{{
			ScenarioID:     "SCN-TEST-001",
			UserRequest:    "Create a purchase order for 50 laptops from vendor V-120.",
			ExpectedTools:  []string{"procurement.create_purchase_order"},
			ExpectedIntent: "purchase_order",
		}},
	})
	for _, expected := range []string{"procurement.create_purchase_order", rule.RuleID, "FEW-SHOT EXAMPLES", "--- candidate_1 ---"} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("expected prompt to contain %q", expected)
		}
	}
}

func TestGeminiCandidateParserExtractsCandidateBlocks(t *testing.T) {
	raw := `--- candidate_1 ---
name: one
description: First
trigger:
  type: manual
steps:
  - id: step_1
    action: policy.check_policy_limit

--- candidate_2 ---
name: two
description: Second
trigger:
  type: manual
steps:
  - id: step_1
    action: procurement.create_purchase_order
`
	candidates := synthesizer.ParseCandidateResponse(raw, "gemini-2.5-flash", false)
	if len(candidates) != 2 {
		t.Fatalf("expected 2 candidates, got %d", len(candidates))
	}
	if candidates[0].CandidateID != "candidate_1" || !strings.Contains(candidates[1].RawYAML, "name: two") {
		t.Fatalf("unexpected parsed candidates: %+v", candidates)
	}
}

func TestRegistryValidatorBlocksUnknownAction(t *testing.T) {
	validator := newRegistryValidator(t)
	result := validator.ValidateCandidate("candidate_unknown", `name: bad
description: Uses a hallucinated action.
trigger:
  type: user.requested
steps:
  - id: auto
    action: auto_approve_payment
    parameters: {}
`, "Workflow Builder")

	if result.Passed {
		t.Fatal("expected unknown action to be blocked")
	}
	if !containsAny(result.Errors, "Unknown or hallucinated tool") {
		t.Fatalf("expected hallucinated tool error, got %#v", result.Errors)
	}
}

func TestRegistryValidatorBlocksMissingVendorID(t *testing.T) {
	validator := newRegistryValidator(t)
	result := validator.ValidateCandidate("candidate_missing_vendor", `name: missing_vendor
description: Missing required vendor id.
trigger:
  type: user.requested
steps:
  - id: create_po
    action: procurement.create_purchase_order
    parameters:
      item_id: laptops
      quantity: 150
  - id: approval
    action: approval.request_human_approval
    parameters:
      approval_reason: High quantity purchase
      approver_role: procurement_manager
  - id: audit
    action: audit.write_audit_log
    parameters:
      event_type: purchase_order_created
      actor_role: Workflow Builder
      decision: queued
`, "Workflow Builder")

	if result.Passed {
		t.Fatal("expected missing vendor_id to be blocked")
	}
	if !containsAny(result.Errors, "vendor_id") {
		t.Fatalf("expected vendor_id missing error, got %#v", result.Errors)
	}
}

func TestRegistryValidatorBlocksEmployeeFinanceClearInvoice(t *testing.T) {
	validator := newRegistryValidator(t)
	result := validator.ValidateCandidate("candidate_rbac", `name: employee_clear_invoice
description: Employee tries to clear an invoice.
trigger:
  type: user.requested
steps:
  - id: invoice_receipt
    action: finance.record_invoice_receipt
    parameters:
      invoice_id: INV-101
  - id: goods_receipt
    action: inventory.record_goods_receipt
    parameters:
      purchase_order_id: PO-101
      received_quantity: 10
  - id: approval
    action: approval.request_human_approval
    parameters:
      approval_reason: Invoice clearing
      approver_role: finance_manager
  - id: clear
    action: finance.clear_invoice
    parameters:
      invoice_id: INV-101
  - id: audit
    action: audit.write_audit_log
    parameters:
      event_type: invoice_cleared
      actor_role: employee
      decision: blocked
`, "employee")

	if result.Passed {
		t.Fatal("expected employee RBAC violation to be blocked")
	}
	if !containsAny(result.Errors, "not allowed") && !hasFailedRule(result, "FIN-RBAC-001") {
		t.Fatalf("expected RBAC error, got errors=%#v failed_rules=%#v", result.Errors, result.FailedRules)
	}
}

func TestRegistryValidatorBlocksClearInvoiceBeforeGoodsReceipt(t *testing.T) {
	validator := newRegistryValidator(t)
	result := validator.ValidateCandidate("candidate_process_order", `name: bad_invoice_order
description: Clears invoice before recording required receipts.
trigger:
  type: user.requested
steps:
  - id: approval
    action: approval.request_human_approval
    parameters:
      approval_reason: Invoice clearing
      approver_role: finance_manager
  - id: clear
    action: finance.clear_invoice
    parameters:
      invoice_id: INV-101
  - id: invoice_receipt
    action: finance.record_invoice_receipt
    parameters:
      invoice_id: INV-101
  - id: goods_receipt
    action: inventory.record_goods_receipt
    parameters:
      purchase_order_id: PO-101
      received_quantity: 10
  - id: audit
    action: audit.write_audit_log
    parameters:
      event_type: invoice_cleared
      actor_role: Workflow Builder
      decision: blocked
`, "Workflow Builder")

	if result.Passed {
		t.Fatal("expected process-order violation to be blocked")
	}
	if !hasFailedRule(result, "FIN-PROC-001") {
		t.Fatalf("expected FIN-PROC-001 failure, got %#v", result.FailedRules)
	}
}

func TestCandidateSelectorChoosesHighestScoringPassedCandidate(t *testing.T) {
	selector := orchestrator.NewCandidateSelector()
	selected, ok := selector.Select([]orchestrator.CandidateReport{
		{CandidateID: "candidate_1", YAML: "low", Validation: workflowvalidator.CandidateValidationResult{CandidateID: "candidate_1", Passed: true, Score: 0.82, EstimatedRisk: "low", StepCount: 4}},
		{CandidateID: "candidate_2", YAML: "blocked", Validation: workflowvalidator.CandidateValidationResult{CandidateID: "candidate_2", Passed: false, Score: 0.99, EstimatedRisk: "low", StepCount: 2}},
		{CandidateID: "candidate_3", YAML: "best", Validation: workflowvalidator.CandidateValidationResult{CandidateID: "candidate_3", Passed: true, Score: 0.96, EstimatedRisk: "medium", StepCount: 5}},
	})

	if !ok {
		t.Fatal("expected selector to find a valid candidate")
	}
	if selected.CandidateID != "candidate_3" {
		t.Fatalf("expected candidate_3, got %s", selected.CandidateID)
	}
}

func TestChatOrchestrationReturnsCanExecuteFalseWhenAllCandidatesFail(t *testing.T) {
	tools := coreregistry.NewToolRegistry([]coreregistry.Tool{{ToolID: "TOOL-001", Name: "known.tool", Status: "active_mcp_schema_present", AllowedRoles: []string{"Workflow Builder"}}}, "tools")
	rules := coreregistry.NewRuleRegistry(nil, "empty-rules")
	search := semanticsearch.NewService(tools, rules, "go_lexical")
	generator, closeFn := newMockGeminiGenerator(t, `--- candidate_1 ---
name: bad
description: Bad candidate
trigger:
  type: manual
steps:
  - id: bad
    action: auto_approve_payment
    parameters: {}
--- candidate_2 ---
name: also_bad
description: Also bad candidate
trigger:
  type: manual
steps:
  - id: bad
    action: hallucinated.tool
    parameters: {}
`)
	defer closeFn()
	validator := workflowvalidator.NewRegistryValidator(tools, rules, repository.NewStore())
	orch := orchestrator.NewChatOrchestrator(search, generator, validator)

	response, err := orch.HandleChatMessage(context.Background(), orchestrator.ChatRequest{
		SessionID:     "chat_test",
		UserText:      "Do something unsupported.",
		UserRole:      "Workflow Builder",
		Mode:          "generate_workflow",
		GenerateCount: 2,
		TopKTools:     3,
		TopKRules:     3,
	})
	if err != nil {
		t.Fatalf("orchestration returned error: %v", err)
	}
	if response.CanExecute {
		t.Fatal("expected can_execute=false when all generated candidates fail")
	}
	if response.ValidationSummary.BlockedCandidates == 0 {
		t.Fatalf("expected blocked candidates, got %+v", response.ValidationSummary)
	}
}

func TestRegistryValidatorBlocksSensitiveParameters(t *testing.T) {
	validator := newRegistryValidator(t)
	result := validator.ValidateCandidate("candidate_secret", `name: secret_parameter
description: Attempts to pass a credential-like value.
trigger:
  type: user.requested
steps:
  - id: policy
    action: policy.check_policy_limit
    parameters:
      policy_domain: finance
      api_key: secret-value
`, "Workflow Builder")

	if result.Passed {
		t.Fatal("expected sensitive parameter to be blocked")
	}
	if !containsAny(result.Errors, "sensitive credential-like parameter") {
		t.Fatalf("expected sensitive parameter error, got %#v", result.Errors)
	}
}

func newRegistryValidator(t *testing.T) *workflowvalidator.RegistryValidator {
	t.Helper()
	return newImplementedRuleRegistryValidator(t)
}

func loadRegistryFixture(t *testing.T) *coreregistry.Bundle {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve test file path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	bundle, err := coreregistry.LoadBundle(
		filepath.Join(root, "configs", "registries", "all_tools_master_registry.json"),
		filepath.Join(root, "configs", "registries", "all_rules_master_registry.json"),
		zap.NewNop(),
	)
	if err != nil {
		t.Fatalf("load registry fixture: %v", err)
	}
	return bundle
}

func loadDatasetFixture(t *testing.T) *coreregistry.Bundle {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve test file path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "dataset"))
	bundle, err := coreregistry.LoadDataset(root, zap.NewNop())
	if err != nil {
		t.Fatalf("load dataset fixture: %v", err)
	}
	return bundle
}

func newMockGeminiGenerator(t *testing.T, text string) (*synthesizer.Service, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{
				{
					"content": map[string]interface{}{
						"parts": []map[string]interface{}{{"text": text}},
					},
				},
			},
		})
	}))
	service := synthesizer.NewServiceWithProvider("", "", false, "gemini", "test-key", "gemini-test")
	service.Gemini.BaseURL = server.URL
	return service, server.Close
}

func hasTool(items []semanticsearch.ToolResult, name string) bool {
	for _, item := range items {
		if item.Name == name {
			return true
		}
	}
	return false
}

func toolNames(items []semanticsearch.ToolResult) []string {
	names := make([]string, 0, len(items))
	for _, item := range items {
		names = append(names, item.Name)
	}
	return names
}

func containsAny(items []string, needle string) bool {
	for _, item := range items {
		if strings.Contains(item, needle) {
			return true
		}
	}
	return false
}

func hasFailedRule(result workflowvalidator.CandidateValidationResult, ruleID string) bool {
	for _, item := range result.FailedRules {
		if item == ruleID {
			return true
		}
	}
	return false
}
