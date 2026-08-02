package synthesizer

import (
	"fmt"
	"strings"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

func TestCandidatePromptBoundsRetrievedContext(t *testing.T) {
	req := CandidateGenerationRequest{
		Prompt:          "Build a workflow",
		UserRole:        "Workflow Builder",
		CandidateCount:  1,
		RegistryContext: "WHOLE_REGISTRY_MUST_NOT_APPEAR",
	}
	for index := 0; index < 14; index++ {
		req.Tools = append(req.Tools, registry.Tool{
			ToolID:             fmt.Sprintf("TOOL-%02d", index),
			Name:               fmt.Sprintf("test.tool_%02d", index),
			Status:             "active_mcp_schema_present",
			Description:        strings.Repeat("description ", 100),
			RequiredParameters: []string{fmt.Sprintf("required_%02d", index)},
		})
	}
	for index := 0; index < 20; index++ {
		req.Rules = append(req.Rules, registry.Rule{
			RuleID:               fmt.Sprintf("RULE-%02d", index),
			RuleName:             strings.Repeat("rule ", 200),
			LLMPromptInstruction: strings.Repeat("instruction ", 200),
		})
	}
	for index := 0; index < 12; index++ {
		req.GlobalRules = append(req.GlobalRules, registry.Rule{RuleID: fmt.Sprintf("GLOBAL-%02d", index)})
	}

	bounded := boundCandidateRequest(req)
	if len(bounded.Tools) != maxPromptTools {
		t.Fatalf("bounded tool count = %d, want %d", len(bounded.Tools), maxPromptTools)
	}
	if len(bounded.GlobalRules) != maxPromptGlobalRules {
		t.Fatalf("bounded global rule count = %d, want %d", len(bounded.GlobalRules), maxPromptGlobalRules)
	}
	if got := len(bounded.Rules) + len(bounded.GlobalRules); got != maxPromptRules {
		t.Fatalf("bounded combined rule count = %d, want %d", got, maxPromptRules)
	}
	if bounded.RegistryContext != "" {
		t.Fatal("whole-registry Markdown survived prompt bounding")
	}

	prompt := NewPromptBuilder().BuildCandidatePrompt(bounded)
	for _, required := range []string{
		"\"name\": \"test.tool_00\"",
		"\"required_parameters\": [",
		"\"required_00\"",
		"\"name\": \"test.tool_09\"",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("bounded prompt omitted %q", required)
		}
	}
	for _, forbidden := range []string{"test.tool_10", "RULE-15", "GLOBAL-08", "WHOLE_REGISTRY_MUST_NOT_APPEAR"} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("bounded prompt retained out-of-budget content %q", forbidden)
		}
	}
	if strings.Contains(prompt, strings.Repeat("description ", 60)) {
		t.Fatal("tool prose exceeded its per-item character budget")
	}
}

func TestCandidatePromptContainsExactSchemaToolGroundingAndStaticExamples(t *testing.T) {
	prompt := NewPromptBuilder().BuildCandidatePrompt(boundCandidateRequest(CandidateGenerationRequest{
		Prompt:         "Echo a value",
		UserRole:       "Workflow Builder",
		CandidateCount: 1,
		Tools: []registry.Tool{{
			ToolID:             "DEMO-ECHO",
			Name:               "demo.echo",
			Status:             "active_mcp_schema_present",
			RequiredParameters: []string{"message", "amount"},
		}},
	}))

	for _, required := range []string{
		"use only these tool names; do not invent tools; include every required parameter.",
		"Each step may contain only: id, type, action, parameters, condition, onError, retryCount, description.",
		"STATIC EXAMPLE 1 - valid single-step shape:",
		"STATIC EXAMPLE 2 - valid step-output reference shape:",
		"{{classify_invoice_step.classification}}",
		"\"required_parameters\": [",
		"\"message\"",
		"\"amount\"",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("candidate prompt omitted %q", required)
		}
	}
}

func TestCandidateRepairPromptContainsSpecificBoundedFeedback(t *testing.T) {
	req := boundCandidateRequest(CandidateGenerationRequest{
		Prompt:         "Build a workflow",
		UserRole:       "Workflow Builder",
		CandidateCount: 5,
		Tools: []registry.Tool{{
			ToolID: "DEMO-ECHO", Name: "demo.echo", Status: "active_mcp_schema_present",
		}},
		Repair: &CandidateRepairFeedback{
			RejectedYAML: "name: broken\nunknown_field: true",
			ValidationErrors: []string{
				"YAML_PARSE_ERROR: field unknown_field not found",
				"YAML_PARSE_ERROR: field unknown_field not found",
			},
		},
	})
	if req.CandidateCount != 5 {
		t.Fatalf("request bounding changed candidate count before generation: %d", req.CandidateCount)
	}
	prompt := NewPromptBuilder().BuildCandidatePrompt(req)
	for _, required := range []string{
		"This is the single bounded repair attempt.",
		"name: broken",
		"YAML_PARSE_ERROR: field unknown_field not found",
		"Return exactly one corrected candidate and no explanation.",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("repair prompt omitted %q", required)
		}
	}
	if strings.Count(prompt, "YAML_PARSE_ERROR: field unknown_field not found") != 1 {
		t.Fatal("repair feedback was not de-duplicated")
	}
}
