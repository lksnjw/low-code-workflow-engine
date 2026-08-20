package handlers

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/gofiber/fiber/v2"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

type credentialResultTool struct {
	result map[string]interface{}
}

func (t credentialResultTool) Name() string        { return "test.transfer" }
func (t credentialResultTool) Description() string { return "credential-shaped result fixture" }
func (t credentialResultTool) Execute(_ context.Context, _ workflowvalidator.DispatchCapability, _ map[string]interface{}) (map[string]interface{}, error) {
	return t.result, nil
}

// runOutputWorkflow creates and runs a workflow, returning the run response.
func runOutputWorkflow(t *testing.T, app *fiber.App, name, yaml string, input map[string]interface{}) map[string]interface{} {
	t.Helper()
	created := registryTestRequest(t, app, http.MethodPost, "/workflows", "admin", map[string]interface{}{"name": name, "yaml": yaml})
	createdBody := decodeJSONBody(t, created)
	created.Body.Close()
	data, _ := createdBody["data"].(map[string]interface{})
	if data == nil {
		t.Fatalf("workflow %q was not created: %+v", name, createdBody)
	}
	id, _ := data["id"].(string)

	response := registryTestRequest(t, app, http.MethodPost, "/workflows/"+id+"/run", "admin", map[string]interface{}{"input": input})
	body := decodeJSONBody(t, response)
	response.Body.Close()
	return body
}

func fetchExecution(t *testing.T, app *fiber.App, executionID string) map[string]interface{} {
	t.Helper()
	response := registryTestRequest(t, app, http.MethodGet, "/executions/"+executionID, "admin", nil)
	body := decodeJSONBody(t, response)
	response.Body.Close()
	data, _ := body["data"].(map[string]interface{})
	if data == nil {
		t.Fatalf("execution %s not returned: %+v", executionID, body)
	}
	return data
}

const singleStepYAML = `name: output_single
description: One tool step whose result is the workflow output.
trigger:
  type: manual
steps:
  - id: transfer
    action: test.transfer
    parameters:
      amount: '{{input.amount}}'
`

const twoStepYAML = `name: output_two_steps
description: Two tool steps, each producing its own output.
trigger:
  type: manual
steps:
  - id: first
    action: test.transfer
    parameters:
      amount: '{{input.amount}}'
  - id: second
    action: test.transfer
    parameters:
      amount: '{{input.amount}}'
`

func TestDoneExecutionExposesFinalOutput(t *testing.T) {
	_, app, _ := failureCategoryApp(t)
	body := runOutputWorkflow(t, app, "output done", singleStepYAML, map[string]interface{}{"amount": 10})
	data, _ := body["data"].(map[string]interface{})
	if data == nil {
		t.Fatalf("run did not succeed: %+v", body)
	}
	executionID, _ := data["id"].(string)

	execution := fetchExecution(t, app, executionID)
	if execution["status"] != models.StatusDone {
		t.Fatalf("status = %v, want DONE", execution["status"])
	}
	final, ok := execution["finalOutput"].(map[string]interface{})
	if !ok {
		t.Fatalf("finalOutput missing from the execution detail response: %+v", execution)
	}
	if final["ok"] != true {
		t.Fatalf("finalOutput = %+v, want the tool result {ok:true}", final)
	}
	stepOutputs, ok := execution["stepOutputs"].(map[string]interface{})
	if !ok || stepOutputs["transfer"] == nil {
		t.Fatalf("stepOutputs missing the step result: %+v", execution["stepOutputs"])
	}
}

func TestMultiStepExecutionExposesEveryStepOutput(t *testing.T) {
	_, app, _ := failureCategoryApp(t)
	body := runOutputWorkflow(t, app, "output multi", twoStepYAML, map[string]interface{}{"amount": 10})
	data, _ := body["data"].(map[string]interface{})
	if data == nil {
		t.Fatalf("run did not succeed: %+v", body)
	}
	executionID, _ := data["id"].(string)

	execution := fetchExecution(t, app, executionID)
	stepOutputs, _ := execution["stepOutputs"].(map[string]interface{})
	for _, stepID := range []string{"first", "second"} {
		if stepOutputs[stepID] == nil {
			t.Fatalf("stepOutputs is missing %q: %+v", stepID, stepOutputs)
		}
	}

	// The timeline must carry each step's output too.
	response := registryTestRequest(t, app, http.MethodGet, "/executions/"+executionID+"/timeline", "admin", nil)
	timelineBody := decodeJSONBody(t, response)
	response.Body.Close()
	steps, _ := timelineBody["data"].([]interface{})
	if len(steps) != 2 {
		t.Fatalf("timeline steps = %d, want 2", len(steps))
	}
	for _, raw := range steps {
		step, _ := raw.(map[string]interface{})
		if step["output"] == nil {
			t.Fatalf("timeline step %v carries no output", step["nodeId"])
		}
	}
}

func TestFailedExecutionExposesPartialOutputAndFailureReason(t *testing.T) {
	_, app, spy := failureCategoryApp(t)
	// The first step succeeds, the second fails, so the run must still report
	// what the first step produced.
	spy.failAfter = 1
	spy.failure = errors.New("connector timeout")
	body := runOutputWorkflow(t, app, "output partial", twoStepYAML, map[string]interface{}{"amount": 10})
	meta, _ := body["meta"].(map[string]interface{})
	executionID, _ := meta["executionId"].(string)
	if executionID == "" {
		t.Fatalf("no executionId returned: %+v", body)
	}

	execution := fetchExecution(t, app, executionID)
	if execution["status"] != models.StatusFailed {
		t.Fatalf("status = %v, want FAILED", execution["status"])
	}
	stepOutputs, ok := execution["stepOutputs"].(map[string]interface{})
	if !ok || stepOutputs["first"] == nil {
		t.Fatalf("partial output from the successful step was lost: %+v", execution["stepOutputs"])
	}
	if stepOutputs["second"] != nil {
		t.Fatalf("the failed step must not report an output: %+v", stepOutputs["second"])
	}
	failure, ok := execution["failure"].(map[string]interface{})
	if !ok {
		t.Fatalf("failure reason missing: %+v", execution)
	}
	if failure["failureCategory"] != models.FailureCategoryToolFailure {
		t.Fatalf("failureCategory = %v, want TOOL_FAILURE", failure["failureCategory"])
	}
	// The final output is the last COMPLETED step, not the failed one.
	final, _ := execution["finalOutput"].(map[string]interface{})
	if final == nil || final["ok"] != true {
		t.Fatalf("finalOutput = %+v, want the last completed step's result", execution["finalOutput"])
	}
}

func TestExecutionOutputRedactsCredentialShapedFields(t *testing.T) {
	state := map[string]interface{}{
		"step": map[string]interface{}{"ok": true, "api_key": "super-secret", "nested": map[string]interface{}{"password": "hunter2"}},
	}
	timeline := []models.ExecutionStep{{NodeID: "step", Status: models.StatusDone}}
	outputs, final := executionOutputs(timeline, state)

	encoded, _ := outputs["step"].(map[string]interface{})
	if encoded == nil {
		t.Fatalf("no output recorded: %+v", outputs)
	}
	if encoded["api_key"] == "super-secret" {
		t.Fatalf("api_key leaked into the execution output: %+v", encoded)
	}
	nested, _ := encoded["nested"].(map[string]interface{})
	if nested != nil && nested["password"] == "hunter2" {
		t.Fatalf("nested password leaked into the execution output: %+v", nested)
	}
	if final == nil {
		t.Fatal("final output was not derived")
	}
}

func TestExecutionLogsRedactCredentialShapedToolResultsAtStorageAndReadBoundaries(t *testing.T) {
	handler, app, _ := failureCategoryApp(t)
	handler.Runner.Registry.Register(credentialResultTool{result: map[string]interface{}{
		"ok":      true,
		"api_key": "storage-secret",
		"nested":  map[string]interface{}{"password": "nested-secret", "visible": "kept"},
	}})

	body := runOutputWorkflow(t, app, "redacted logs", singleStepYAML, map[string]interface{}{"amount": 10})
	data, _ := body["data"].(map[string]interface{})
	executionID, _ := data["id"].(string)
	if executionID == "" {
		t.Fatalf("run did not return an execution: %+v", body)
	}

	stored := handler.Store.ExecutionLogs[executionID]
	if len(stored) != 1 {
		t.Fatalf("stored logs = %d, want 1", len(stored))
	}
	assertExecutionLogSecretsRedacted(t, "stored", stored[0].Metadata)

	// Simulate a legacy record written before write-time redaction existed, so
	// this assertion independently proves the read boundary is fail-safe.
	handler.Store.ExecutionLogs[executionID][0].Metadata = map[string]interface{}{
		"api_key": "legacy-secret",
		"nested":  map[string]interface{}{"password": "legacy-nested-secret", "visible": "kept"},
	}

	response := registryTestRequest(t, app, http.MethodGet, "/executions/"+executionID+"/logs", "admin", nil)
	responseBody := decodeJSONBody(t, response)
	response.Body.Close()
	items, _ := responseBody["data"].([]interface{})
	if len(items) != 1 {
		t.Fatalf("logs endpoint returned %d items: %+v", len(items), responseBody)
	}
	logItem, _ := items[0].(map[string]interface{})
	metadata, _ := logItem["metadata"].(map[string]interface{})
	assertExecutionLogSecretsRedacted(t, "response", metadata)
}

func assertExecutionLogSecretsRedacted(t *testing.T, boundary string, metadata map[string]interface{}) {
	t.Helper()
	if metadata == nil {
		t.Fatalf("%s metadata is missing", boundary)
	}
	if _, exists := metadata["api_key"]; exists {
		t.Fatalf("%s metadata retained api_key: %+v", boundary, metadata)
	}
	nested, _ := metadata["nested"].(map[string]interface{})
	if nested == nil || nested["visible"] != "kept" {
		t.Fatalf("%s metadata lost non-secret nested data: %+v", boundary, metadata)
	}
	if _, exists := nested["password"]; exists {
		t.Fatalf("%s metadata retained nested password: %+v", boundary, metadata)
	}
}

func TestAnalysisStepOutputIsUnwrapped(t *testing.T) {
	// The runner stores an analysis result wrapped as {"output": ...}; the
	// execution record must expose the inner value, not the wrapper.
	state := map[string]interface{}{
		"analyse": map[string]interface{}{"output": map[string]interface{}{"summary": "three invoices"}},
	}
	timeline := []models.ExecutionStep{{NodeID: "analyse", Status: models.StatusDone}}
	_, final := executionOutputs(timeline, state)
	value, _ := final.(map[string]interface{})
	if value == nil || value["summary"] != "three invoices" {
		t.Fatalf("analysis output was not unwrapped: %+v", final)
	}
}
