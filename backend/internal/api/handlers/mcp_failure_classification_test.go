package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
)

func TestMockErpHTTPFailuresAreClassifiedWithoutParsingText(t *testing.T) {
	handler := &Handler{}
	result := runner.Result{Timeline: []models.ExecutionStep{{
		ID: "step_001", NodeID: "erp", Status: models.StatusFailed, StartedAt: time.Now(),
	}}}
	cases := []struct {
		name       string
		err        error
		want       string
		wantHealed bool
	}{
		{"invalid", &tools.MCPHTTPError{StatusCode: 400}, models.FailureCategoryInvalidRequest, false},
		{"auth", &tools.MCPHTTPError{StatusCode: 401}, models.FailureCategoryAuthDenied, false},
		{"forbidden", &tools.MCPHTTPError{StatusCode: 403}, models.FailureCategoryAuthDenied, false},
		{"notfound", &tools.MCPHTTPError{StatusCode: 404}, models.FailureCategoryNotFound, false},
		{"transient", &tools.MCPHTTPError{StatusCode: 503}, models.FailureCategoryTransient, true},
		{"timeout", context.DeadlineExceeded, models.FailureCategoryTransient, true},
		{"unrecognised", &tools.MCPHTTPError{StatusCode: 418}, models.FailureCategoryToolFailure, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			wrapped := fmt.Errorf("step erp failed: %w", testCase.err)
			failure := handler.classifyExecutionFailure(models.WorkflowBlueprint{}, result, wrapped, "erp", "demo.echo")
			if failure.FailureCategory != testCase.want {
				t.Fatalf("FailureCategory = %s, want %s", failure.FailureCategory, testCase.want)
			}
			gotHealed := failure.FailureCategory == models.FailureCategoryTransient
			if gotHealed != testCase.wantHealed {
				t.Fatalf("healable = %t, want %t", gotHealed, testCase.wantHealed)
			}
		})
	}
}

func TestForbiddenToolFailureIsTerminalAuthDeniedAndAudited(t *testing.T) {
	handler, store, app, spy := newGateTestHandler()
	handler.Healer = &healing.Healer{MaxAttempts: 0}
	spy.failure = &tools.MCPHTTPError{StatusCode: http.StatusForbidden}
	store.Workflows["wf-forbidden"] = &models.Workflow{
		ID: "wf-forbidden", Name: "authorised workflow", YAML: validWorkflowYAML("25"), Status: models.StatusPending,
	}

	response := gateRequest(t, app, http.MethodPost, "/workflows/wf-forbidden/run", map[string]interface{}{"input": map[string]interface{}{}})
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", response.StatusCode, body)
	}
	for _, expected := range []string{"Step transfer", "`test.transfer`", "not authorised to call this tool"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("response omitted %q: %s", expected, body)
		}
	}
	if strings.Contains(body, "HTTP 403") {
		t.Fatalf("response exposed the downstream status error: %s", body)
	}

	execution := executionForWorkflow(store, "wf-forbidden")
	if execution == nil || execution.Status != models.StatusFailed || execution.Failure == nil {
		t.Fatalf("execution did not retain terminal failure evidence: %+v", execution)
	}
	if execution.Failure.FailureCategory != models.FailureCategoryAuthDenied {
		t.Fatalf("failure category = %s, want %s", execution.Failure.FailureCategory, models.FailureCategoryAuthDenied)
	}
	if report := store.Healing[execution.ID]; report.Status != "HEALING_NOT_ATTEMPTED" {
		t.Fatalf("403 entered healing: %+v", report)
	}

	auditFound := false
	for _, entry := range store.AuditLogs {
		if entry.Action != "execution.failure.classified" || entry.Resource.ID != execution.ID {
			continue
		}
		auditFound = entry.Actor.ID == "test-admin" &&
			entry.After["stepId"] == "transfer" &&
			entry.After["toolName"] == "test.transfer" &&
			entry.After["category"] == models.FailureCategoryAuthDenied
	}
	if !auditFound {
		t.Fatal("classified 403 audit did not contain actor, step, tool, and category")
	}
}
