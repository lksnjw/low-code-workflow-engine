package orchestrator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestChatOrchestratorUsesSingleValidatorGuidedRepair(t *testing.T) {
	const invalidYAML = `name: broken_echo
description: Uses an invented action.
trigger:
  type: manual
steps:
  - id: echo_step
    type: tool
    action: invented.tool
    parameters:
      message: hello`
	const validYAML = `name: repaired_echo
description: Echoes the supplied message.
trigger:
  type: manual
steps:
  - id: echo_step
    type: tool
    action: demo.echo
    parameters:
      message: hello
    onError: stop
    retryCount: 1`

	var mu sync.Mutex
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read Gemini request: %v", err)
		}
		var payload struct {
			Contents []struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("decode Gemini request: %v", err)
		}
		prompt := ""
		if len(payload.Contents) > 0 && len(payload.Contents[0].Parts) > 0 {
			prompt = payload.Contents[0].Parts[0].Text
		}

		mu.Lock()
		requests = append(requests, prompt)
		requestNumber := len(requests)
		mu.Unlock()

		candidate := invalidYAML
		if requestNumber == 2 {
			candidate = validYAML
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{{
				"content": map[string]interface{}{
					"parts": []map[string]string{{"text": candidate}},
				},
			}},
			"usageMetadata": map[string]int{
				"promptTokenCount":     100 + requestNumber,
				"candidatesTokenCount": 20,
			},
		})
	}))
	defer server.Close()

	tools := registry.NewToolRegistry([]registry.Tool{{
		ToolID:             "DEMO-ECHO",
		Name:               "demo.echo",
		Module:             "demo",
		Status:             "active_mcp_schema_present",
		Description:        "Echo a message",
		RequiredParameters: []string{"message"},
		RiskLevel:          "low",
	}}, "tools-test")
	rules := registry.NewRuleRegistry(nil, "rules-test")
	search := semanticsearch.NewService(tools, rules, "go_lexical")
	generator := synthesizer.NewServiceWithProvider("", "", false, "gemini", "test-key", "gemini-test")
	generator.Gemini.BaseURL = server.URL
	generator.Gemini.HTTP = server.Client()
	validator := workflowvalidator.NewRegistryValidator(tools, rules, repository.NewStore())
	orchestrator := NewChatOrchestrator(search, generator, validator)

	result, err := orchestrator.HandleChatMessage(context.Background(), ChatRequest{
		SessionID:     "repair-test",
		UserText:      "Echo a message",
		UserRole:      "Workflow Builder",
		TopKTools:     1,
		TopKRules:     1,
		TopKTemplates: 1,
		TopKExamples:  1,
		GenerateCount: 1,
	})
	if err != nil {
		t.Fatalf("HandleChatMessage returned an error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 {
		t.Fatalf("provider request count = %d, want exactly 2", len(requests))
	}
	for _, required := range []string{"single bounded repair attempt", "invented.tool", "Unknown or hallucinated tool"} {
		if !strings.Contains(requests[1], required) {
			t.Fatalf("repair prompt omitted %q", required)
		}
	}
	if !result.CanExecute {
		t.Fatalf("repaired workflow was not executable: %#v", result.BlockingErrors)
	}
	if result.SelectedCandidateID != "repair_candidate_1" {
		t.Fatalf("selected candidate = %q, want repair_candidate_1", result.SelectedCandidateID)
	}
	if len(result.Candidates) != 2 || result.Candidates[0].Validation.Passed || !result.Candidates[1].Validation.Passed {
		t.Fatalf("initial/repair validation sequence was not preserved: %#v", result.Candidates)
	}
	if got := result.Candidates[1].Generation["generationAttempt"]; got != "repair" {
		t.Fatalf("repair generationAttempt = %#v, want repair", got)
	}
}
