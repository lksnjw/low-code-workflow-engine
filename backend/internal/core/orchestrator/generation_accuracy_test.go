package orchestrator

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

var generationAccuracyRequests = []string{
	"Create a manual workflow that echoes input message and amount using demo.echo.",
	"Classify invoice INV-1001, then notify finance with classification result.",
	"Fetch attendance EMP-1001 2026-08-01.",
	"Create annual leave EMP-1002 2026-08-10 to 2026-08-12.",
	"Refresh connector finance-primary.",
	"Send webhook notification callback invoice processed.",
	"Validate vendor V-1007.",
	"Validate V-1008 and create PO ITEM-1008 quantity 50.",
	"Validate V-1009 and create PO ITEM-1009 quantity 150 with approval and audit.",
	"Record invoice receipt INV-1010 and audit it.",
	"Record goods receipt PO-1011 item ITEM-1011 quantity 20.",
	"Record invoice receipt INV-1012, record goods receipt PO-1012 item ITEM-1012 quantity 10, clear it, and notify finance.",
	"Create shipment for order ORD-1013, then retrieve the shipment.",
	"Check the policy limit for a purchase quantity of 80.",
	"Request human approval from manager for PO-1015.",
	"Write an audit log for workflow WF-1016 with actor Platform Admin and decision approved.",
	"Create a capability request for vendor-ledger automation.",
	"Generate runtime registry context using the registered demo context tool.",
	"Import demo registry payload using the registered demo registry import tool.",
	"Build a finance exception workflow: classify invoice INV-1020, check policy, notify finance, send a webhook, and write an audit log.",
}

func TestGenerationFirstPassAccuracy20(t *testing.T) {
	apiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY is not set; the measured 20-request accuracy check is opt-in")
	}

	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve accuracy test path")
	}
	backendRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	bundle, err := registry.LoadBundle(
		filepath.Join(backendRoot, "configs", "runtime", "all_tools_master_registry.json"),
		filepath.Join(backendRoot, "configs", "runtime", "all_rules_master_registry.json"),
		zap.NewNop(),
	)
	if err != nil {
		t.Fatalf("load runtime registry: %v", err)
	}

	model := strings.TrimSpace(os.Getenv("GENERATION_ACCURACY_MODEL"))
	if model == "" {
		model = "gemini-2.5-flash"
	}
	generator := synthesizer.NewServiceWithProvider("", "", false, "gemini", apiKey, model)
	if baseURL := strings.TrimSpace(os.Getenv("GENERATION_ACCURACY_BASE_URL")); baseURL != "" {
		generator.Gemini.BaseURL = baseURL
	}
	validator := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, repository.NewStore())
	orchestrator := NewChatOrchestrator(
		semanticsearch.NewServiceFromDataset(bundle, "go_lexical", "", true),
		generator,
		validator,
	)

	firstPass := 0
	afterRepair := 0
	totalInputTokens := 0
	for index, prompt := range generationAccuracyRequests {
		response, err := orchestrator.HandleChatMessage(context.Background(), ChatRequest{
			SessionID:     "accuracy",
			UserText:      prompt,
			UserRole:      "Platform Admin",
			Mode:          "generate_workflow",
			TopKTools:     10,
			TopKRules:     15,
			TopKTemplates: 5,
			TopKExamples:  3,
			GenerateCount: 1,
		})
		if err != nil {
			t.Fatalf("GEN%02d generation failed: %v", index+1, err)
		}

		initialPassed := false
		repairPassed := false
		for _, report := range response.Candidates {
			if report.Generation["measured"] != true {
				t.Fatalf("GEN%02d provider did not report measured token usage", index+1)
			}
			tokens, ok := report.Generation["inputTokens"].(int)
			if !ok {
				t.Fatalf("GEN%02d inputTokens has type %T", index+1, report.Generation["inputTokens"])
			}
			totalInputTokens += tokens
			if report.Generation["generationAttempt"] == "repair" {
				repairPassed = repairPassed || report.Validation.Passed
			} else {
				initialPassed = initialPassed || report.Validation.Passed
			}
		}
		if initialPassed {
			firstPass++
		} else if repairPassed {
			afterRepair++
		}
		t.Logf("GEN%02d first_pass=%t after_repair=%t can_execute=%t", index+1, initialPassed, repairPassed, response.CanExecute)
	}

	t.Logf(
		"GENERATION_ACCURACY requests=%d first_pass=%d after_repair=%d unresolved=%d average_measured_input_tokens=%.2f",
		len(generationAccuracyRequests),
		firstPass,
		afterRepair,
		len(generationAccuracyRequests)-firstPass-afterRepair,
		float64(totalInputTokens)/float64(len(generationAccuracyRequests)),
	)
}
