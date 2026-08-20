//go:build experiment

package unit

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

func (s *spyPolicyTool) ExperimentNoExternalDispatch() {}

func TestBaselineBExecutesDispatchViolationAndAuditsBypass(t *testing.T) {
	validator, executor, spy := newPolicyExecutor()
	if err := executor.SetBaselineB(true); err != nil {
		t.Fatalf("enable Baseline B with spy tools: %v", err)
	}
	rawYAML := thresholdWorkflowYAML(`"{{input.amount}}"`)
	token, result, err := validator.ValidateAndIssueToken("baseline-b-plan", rawYAML, "Workflow Builder")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("expected deferred plan to pass: result=%+v token=%+v err=%v", result, token, err)
	}

	workflow := models.Workflow{ID: "wf-baseline-b", Name: "Baseline B", YAML: rawYAML}
	_, runErr := executor.Run(context.Background(), "run-baseline-b", workflow, map[string]interface{}{"amount": 123456}, token)
	if runErr != nil {
		t.Fatalf("Baseline B should execute despite dispatch violation: %v", runErr)
	}
	if spy.calls != 1 {
		t.Fatalf("expected spy tool execution, got %d calls", spy.calls)
	}
	if !baselineAuditFound(validator.Store, "dispatch_revalidation", "TEST-THRESH-001") {
		t.Fatal("expected Baseline B dispatch bypass audit")
	}
}

func TestBaselineBBypassesMissingTokenWhileDefaultStillBlocks(t *testing.T) {
	workflow := models.Workflow{ID: "wf-token-comparison", Name: "Token comparison", YAML: thresholdWorkflowYAML("25")}

	_, gatedExecutor, gatedSpy := newPolicyExecutor()
	if _, err := gatedExecutor.Run(context.Background(), "run-gated", workflow, map[string]interface{}{}, nil); err == nil {
		t.Fatal("expected default mode to block a missing token")
	}
	if gatedSpy.calls != 0 {
		t.Fatalf("default mode executed %d tool calls", gatedSpy.calls)
	}

	validator, baselineExecutor, baselineSpy := newPolicyExecutor()
	if err := baselineExecutor.SetBaselineB(true); err != nil {
		t.Fatalf("enable Baseline B with spy tools: %v", err)
	}
	if _, err := baselineExecutor.Run(context.Background(), "run-baseline-token", workflow, map[string]interface{}{}, nil); err != nil {
		t.Fatalf("Baseline B should bypass the missing token: %v", err)
	}
	if baselineSpy.calls != 1 {
		t.Fatalf("expected Baseline B spy execution, got %d calls", baselineSpy.calls)
	}
	if !baselineAuditFound(validator.Store, "validation_token_required", "") {
		t.Fatal("expected Baseline B token bypass audit")
	}
}

func TestExperimentGateOffRejectsRealMCPToolRegistry(t *testing.T) {
	validator, _, _ := newPolicyExecutor()
	realRegistry := tools.NewRegistry(nil)
	realRegistry.Register(tools.GenericMCPTool{Action: "test.transfer", Client: tools.NewMCPClient("https://bridge.invalid", time.Second)})
	executor := runner.NewExecutor(realRegistry, validator, zap.NewNop())
	err := executor.SetBaselineB(true)
	if err == nil || !strings.Contains(err.Error(), "not a spy/no-op tool") {
		t.Fatalf("expected real MCP registry startup refusal, got %v", err)
	}
}

func baselineAuditFound(store *repository.Store, decision, ruleID string) bool {
	store.Mu.RLock()
	defer store.Mu.RUnlock()
	for _, entry := range store.AuditLogs {
		if entry.After["baseline"] != "B" || entry.After["decision"] != decision || entry.After["would_have_blocked"] != true {
			continue
		}
		if ruleID == "" {
			return true
		}
		evidence, ok := entry.After["evidence"].(map[string]interface{})
		if ok && evidence["rule_id"] == ruleID {
			return true
		}
	}
	return false
}
