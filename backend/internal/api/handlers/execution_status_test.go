package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func TestHealingResolvesToTerminalStatus(t *testing.T) {
	handler, store, app, spy := newGateTestHandler()
	handler.Healer = &healing.Healer{MaxAttempts: 0}
	spy.failure = errors.New("connector unavailable")
	store.Workflows["wf-healing"] = &models.Workflow{
		ID: "wf-healing", Name: "healing workflow", YAML: validWorkflowYAML("25"), Status: models.StatusPending,
	}

	response := gateRequest(t, app, "POST", "/workflows/wf-healing/run", map[string]interface{}{"input": map[string]interface{}{}})
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", response.StatusCode, responseBody(t, response))
	}
	execution := executionForWorkflow(store, "wf-healing")
	if execution == nil || execution.Status != models.StatusFailed {
		t.Fatalf("expected terminal FAILED status, got %+v", execution)
	}
	if execution.Status == models.StatusHealing {
		t.Fatal("HEALING remained terminal after the healing attempt")
	}
	if report := store.Healing[execution.ID]; report.Status != "REPAIR_FAILED" {
		t.Fatalf("expected failed repair evidence, got %+v", report)
	}
}

func TestFailedRunReturns422WithStepAndTool(t *testing.T) {
	_, store, app, spy := newGateTestHandler()
	spy.failure = errors.New("connector unavailable")
	store.Workflows["wf-failed"] = &models.Workflow{
		ID: "wf-failed", Name: "payment sync", YAML: validWorkflowYAML("25"), Status: models.StatusPending,
	}

	response := gateRequest(t, app, "POST", "/workflows/wf-failed/run", map[string]interface{}{"input": map[string]interface{}{}})
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", response.StatusCode)
	}
	body := responseBody(t, response)
	for _, expected := range []string{"payment sync", "transfer", "test.transfer", "connector unavailable"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("failed response does not name %q: %s", expected, body)
		}
	}
}

func TestSuccessfulRunReturns200(t *testing.T) {
	_, store, app, _ := newGateTestHandler()
	store.Workflows["wf-success"] = &models.Workflow{
		ID: "wf-success", Name: "successful sync", YAML: validWorkflowYAML("25"), Status: models.StatusPending,
	}

	response := gateRequest(t, app, "POST", "/workflows/wf-success/run", map[string]interface{}{"input": map[string]interface{}{}})
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.StatusCode, responseBody(t, response))
	}
	body := responseBody(t, response)
	if !strings.Contains(body, "Workflow successful sync completed successfully in 1 steps") {
		t.Fatalf("success response did not name workflow and step count: %s", body)
	}
}

func TestDispatchPolicyViolationStillFailedNeverHealed(t *testing.T) {
	_, store, app, spy := newGateTestHandler()
	store.Workflows["wf-policy"] = &models.Workflow{
		ID: "wf-policy", Name: "policy workflow", YAML: validWorkflowYAML(`"{{input.amount}}"`), Status: models.StatusPending,
	}

	response := gateRequest(t, app, "POST", "/workflows/wf-policy/run", map[string]interface{}{"input": map[string]interface{}{"amount": 101}})
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", response.StatusCode, responseBody(t, response))
	}
	execution := executionForWorkflow(store, "wf-policy")
	if execution == nil || execution.Status != models.StatusFailed {
		t.Fatalf("expected FAILED policy execution, got %+v", execution)
	}
	if _, exists := store.Healing[execution.ID]; exists {
		t.Fatal("dispatch policy violation entered healing")
	}
	if spy.calls != 0 {
		t.Fatalf("dispatch policy violation invoked the tool %d times", spy.calls)
	}
}

func TestSuccessRateCountsAllTerminalExecutions(t *testing.T) {
	now := time.Now().UTC()
	store := repository.NewStore()
	store.Workflows["wf-rate"] = &models.Workflow{ID: "wf-rate"}
	store.Executions["done"] = &models.Execution{ID: "done", WorkflowID: "wf-rate", Status: models.StatusDone, CompletedAt: &now}
	store.Executions["failed"] = &models.Execution{ID: "failed", WorkflowID: "wf-rate", Status: models.StatusFailed, CompletedAt: &now}
	store.Executions["legacy-healing"] = &models.Execution{ID: "legacy-healing", WorkflowID: "wf-rate", Status: models.StatusHealing, CompletedAt: &now}
	handler := &Handler{Store: store}

	store.Mu.Lock()
	handler.updateWorkflowExecutionMetricsLocked("wf-rate", now)
	store.Mu.Unlock()

	if got := store.Workflows["wf-rate"].SuccessRate; got < 33.33 || got > 33.34 {
		t.Fatalf("expected one success across all three completed terminal records, got %.4f", got)
	}

	app := fiber.New()
	app.Get("/analytics", handler.AnalyticsSummary)
	app.Get("/dashboard", handler.DashboardSummary)
	analytics := gateRequest(t, app, "GET", "/analytics", nil)
	dashboard := gateRequest(t, app, "GET", "/dashboard", nil)
	assertSuccessRateResponse(t, analytics, "successRate")
	assertDashboardSuccessRate(t, dashboard)
}

func assertSuccessRateResponse(t *testing.T, response *http.Response, key string) {
	t.Helper()
	var payload struct {
		Data map[string]interface{} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode success-rate response: %v", err)
	}
	value, _ := payload.Data[key].(float64)
	if value < 33.33 || value > 33.34 {
		t.Fatalf("expected %s to count all three terminal records, got %.4f", key, value)
	}
}

func assertDashboardSuccessRate(t *testing.T, response *http.Response) {
	t.Helper()
	var payload struct {
		Data struct {
			Metrics []map[string]interface{} `json:"metrics"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode dashboard response: %v", err)
	}
	for _, metric := range payload.Data.Metrics {
		if metric["key"] == "successfulRuns" {
			value, _ := metric["value"].(float64)
			if value >= 33.33 && value <= 33.34 {
				return
			}
			t.Fatalf("dashboard success rate did not count all terminal records: %.4f", value)
		}
	}
	t.Fatal("dashboard success-rate metric was not returned")
}

func TestStartupMarksOrphanedRunningExecutionsFailed(t *testing.T) {
	started := time.Now().UTC().Add(-time.Minute)
	reconciledAt := time.Now().UTC()
	store := repository.NewStore()
	store.Workflows["wf-orphan"] = &models.Workflow{ID: "wf-orphan"}
	store.Executions["run-orphan"] = &models.Execution{
		ID: "run-orphan", WorkflowID: "wf-orphan", Status: models.StatusRunning, StartedAt: started,
	}

	if count := ReconcileOrphanedRunningExecutions(store, reconciledAt); count != 1 {
		t.Fatalf("expected one reconciled execution, got %d", count)
	}
	execution := store.Executions["run-orphan"]
	if execution.Status != models.StatusFailed || execution.CompletedAt == nil {
		t.Fatalf("orphaned execution was not terminal FAILED: %+v", execution)
	}
	logs := store.ExecutionLogs["run-orphan"]
	if len(logs) != 1 || logs[0].Message != restartFailureReason {
		t.Fatalf("restart reason was not recorded: %+v", logs)
	}
}

func TestChatErrorDoesNotLeakUnderlyingError(t *testing.T) {
	core, observed := observer.New(zapcore.ErrorLevel)
	handler := &Handler{Log: zap.New(core)}
	underlying := errors.New("provider credential super-secret")

	err := handler.chatOrchestrationFailure(underlying)
	fiberErr, ok := err.(*fiber.Error)
	if !ok {
		t.Fatalf("expected Fiber error, got %T", err)
	}
	if strings.Contains(fiberErr.Message, underlying.Error()) {
		t.Fatalf("browser message leaked the underlying error: %s", fiberErr.Message)
	}
	if !strings.Contains(fiberErr.Message, "trace ID ") {
		t.Fatalf("browser message did not include a trace ID: %s", fiberErr.Message)
	}
	if observed.Len() != 1 {
		t.Fatalf("expected one detailed backend log, got %d", observed.Len())
	}
	if !strings.Contains(fmt.Sprint(observed.All()[0].ContextMap()["error"]), underlying.Error()) {
		t.Fatalf("backend log did not retain the underlying error: %+v", observed.All()[0].ContextMap())
	}
}

func executionForWorkflow(store *repository.Store, workflowID string) *models.Execution {
	for _, execution := range store.Executions {
		if execution.WorkflowID == workflowID {
			return execution
		}
	}
	return nil
}
