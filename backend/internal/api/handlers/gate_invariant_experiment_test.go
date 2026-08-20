//go:build experiment

package handlers

import (
	"net/http"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (s *handlerSpyTool) ExperimentNoExternalDispatch() {}

func TestBaselineBHandlerExecutesPlanBlockedWorkflowAndAuditsBypass(t *testing.T) {
	handler, store, app, spy := newGateTestHandler()
	if err := handler.Runner.SetBaselineB(true); err != nil {
		t.Fatalf("enable Baseline B with spy tools: %v", err)
	}
	store.Workflows["wf-baseline"] = &models.Workflow{ID: "wf-baseline", Name: "baseline", YAML: validWorkflowYAML("101"), Status: models.StatusPending}

	response := gateRequest(t, app, http.MethodPost, "/workflows/wf-baseline/run", map[string]interface{}{"input": map[string]interface{}{}})
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("expected Baseline B execution result, got %d: %s", response.StatusCode, responseBody(t, response))
	}
	if spy.calls != 1 {
		t.Fatalf("expected Baseline B to execute spy tool, got %d calls", spy.calls)
	}
	baselineAuditFound := false
	for _, entry := range store.AuditLogs {
		if entry.After["baseline"] == "B" && entry.After["decision"] == "plan_validation" && entry.After["would_have_blocked"] == true {
			baselineAuditFound = true
			break
		}
	}
	if !baselineAuditFound {
		t.Fatal("expected plan bypass audit with baseline B")
	}
}
