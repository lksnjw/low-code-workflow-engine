package handlers

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
)

func (h *Handler) RunWorkflow(c *fiber.Ctx) error {
	var req models.RunWorkflowRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	return h.runWorkflowByID(c, c.Params("id"), req)
}

func (h *Handler) runWorkflowByID(c *fiber.Ctx, workflowID string, req models.RunWorkflowRequest) error {
	workflow, ok := h.workflowByID(workflowID)
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	user := h.currentUser(c)
	if !canRunWorkflow(user, workflow) {
		return fiber.NewError(fiber.StatusForbidden, "Workflow is not assigned to the current user")
	}
	if workflow.Status == models.StatusDraftUnvalidated {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow canvas has unvalidated execution changes", map[string]interface{}{"status": workflow.Status}))
	}
	validation, blueprint := h.Validator.ValidateYAML(workflow.YAML, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed validation before execution", validation))
	}
	token, fullValidation, gateErr := h.validateWithFullGate(c, "RunWorkflow", workflow.YAML)
	if gateErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, gateErr.Error())
	}
	if !fullValidation.Passed {
		handled, rejectionErr := h.handleRejectedPlan(c, workflow, fullValidation)
		if handled {
			return rejectionErr
		}
	}
	if req.DryRun {
		planned := []map[string]interface{}{}
		for _, step := range blueprint.Steps {
			planned = append(planned, map[string]interface{}{"id": step.ID, "action": step.Action, "parameters": step.Parameters})
		}
		return c.JSON(models.OK(map[string]interface{}{"can_execute": true, "dry_run": true, "validation": fullValidation, "planned_steps": planned}, "Dry run validation passed", nil))
	}

	now := time.Now().UTC()
	executionID := "run-" + randomHex(4)
	execution := &models.Execution{
		ID: executionID, WorkflowID: workflow.ID, WorkflowName: workflow.Name, Status: models.StatusRunning,
		StartedAt: now, StartedBy: principalFromUser(h.currentUser(c)),
	}

	h.Store.Mu.Lock()
	runningExecution := *execution
	h.Store.Executions[executionID] = &runningExecution
	h.Store.Mu.Unlock()

	runResult, err := h.Runner.Run(c.Context(), executionID, *workflow, req.Input, token)
	completed := time.Now().UTC()
	execution.CompletedAt = &completed
	execution.DurationMS = completed.Sub(now).Milliseconds()
	execution.Tokens = runResult.Tokens
	// The runner accumulates every step's output in its state snapshot. Carry
	// it onto the execution record so the detail endpoint can return it; this
	// runs for a failed run too, so partial results survive.
	attachStepOutputs(runResult.Timeline, runResult.State)
	execution.StepOutputs, execution.FinalOutput = executionOutputs(runResult.Timeline, runResult.State)
	failedStep, failedTool, failureReason := "", "", ""

	if err != nil {
		failedStep, failedTool, failureReason = executionFailureDetails(blueprint, runResult, err)
		execution.Status = models.StatusFailed
		var policyViolation *runner.ErrDispatchPolicyViolation
		var dataEgressViolation *runner.ErrDataEgressViolation
		// Classify the failure so the UI can show a governance block as a
		// governance block rather than as a crashed tool. The runner decides a
		// policy violation immediately before dispatch, so on that path the
		// tool was never invoked.
		execution.Failure = h.classifyExecutionFailure(blueprint, runResult, err, failedStep, failedTool)
		attachStepFailure(runResult.Timeline, execution.Failure)
		if execution.Failure != nil && execution.Failure.FailureCategory == models.FailureCategoryTransient && h.Healer != nil {
			execution.Status = models.StatusHealing
			repairedYAML, event, healErr := h.Healer.Repair(c.Context(), workflow.Name, workflow.YAML, err)
			if healErr == nil {
				_, repairValidation, validationErr := h.validateWithFullGate(c, "HealingRepair", repairedYAML)
				repairValid := validationErr == nil && repairValidation.Passed
				if event != nil {
					event["validation"] = repairValidation
				}
				h.Store.Mu.Lock()
				status := "REPAIR_REJECTED"
				summary := "Execution failed and self-healing generated YAML, but it did not pass full registry validation."
				if repairValid {
					workflow.YAML = repairedYAML
					status = "VALIDATED_REPAIR_AVAILABLE"
					summary = "Execution failed; a validated repair is available, but it was not re-executed."
				}
				events := []map[string]interface{}{}
				if event != nil {
					events = append(events, event)
				}
				h.Store.Healing[executionID] = models.HealingReport{ExecutionID: executionID, WorkflowID: workflow.ID, Status: status, Summary: summary, Events: events, Metrics: map[string]interface{}{}}
				h.Store.Mu.Unlock()
			} else {
				h.Store.Mu.Lock()
				h.Store.Healing[executionID] = models.HealingReport{ExecutionID: executionID, WorkflowID: workflow.ID, Status: "REPAIR_FAILED", Summary: "Execution failed and no validated repair could be generated.", Events: []map[string]interface{}{}, Metrics: map[string]interface{}{}}
				h.Store.Mu.Unlock()
			}
			execution.Status = models.StatusFailed
		} else if !errors.As(err, &policyViolation) && !errors.As(err, &dataEgressViolation) {
			h.Store.Mu.Lock()
			h.Store.Healing[executionID] = models.HealingReport{ExecutionID: executionID, WorkflowID: workflow.ID, Status: "HEALING_NOT_ATTEMPTED", Summary: "Execution failed and self-healing was not available.", Events: []map[string]interface{}{}, Metrics: map[string]interface{}{}}
			h.Store.Mu.Unlock()
		}
	} else {
		execution.Status = models.StatusDone
	}

	h.Store.Mu.Lock()
	completedExecution := *execution
	h.Store.Executions[executionID] = &completedExecution
	h.Store.ExecutionLogs[executionID] = append(h.Store.ExecutionLogs[executionID], runResult.Logs...)
	h.Store.Timelines[executionID] = append(h.Store.Timelines[executionID], runResult.Timeline...)
	h.updateWorkflowExecutionMetricsLocked(workflow.ID, completed)
	if execution.Failure != nil {
		h.Store.Audit(
			execution.StartedBy,
			"execution.failure.classified",
			models.ResourceRef{Type: "execution", ID: execution.ID},
			nil,
			map[string]interface{}{
				"stepId":   execution.Failure.FailedStepID,
				"toolName": execution.Failure.FailedToolName,
				"category": execution.Failure.FailureCategory,
			},
			c.IP(),
			c.Get("User-Agent"),
		)
	}
	h.Store.Mu.Unlock()

	if execution.Status == models.StatusFailed {
		message := "Workflow " + workflow.Name + " failed at step " + failedStep + " using tool " + failedTool + ": " + failureReason
		if execution.Failure != nil && execution.Failure.FailureCategory == models.FailureCategoryAuthDenied {
			message = fmt.Sprintf("Step %s (`%s`): not authorised to call this tool.", failedStep, failedTool)
		}
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail(message, map[string]interface{}{"executionId": execution.ID, "status": execution.Status}))
	}
	message := "Workflow " + workflow.Name + " completed successfully in " + strconv.Itoa(len(runResult.Timeline)) + " steps"
	return c.JSON(models.OK(execution, message, nil))
}

// stepOutputValue normalises what the runner stored for a step. An analysis
// step is saved wrapped as {"output": ...}; a tool step stores the tool result
// map as-is.
func stepOutputValue(raw interface{}) interface{} {
	wrapper, ok := raw.(map[string]interface{})
	if !ok {
		return raw
	}
	if len(wrapper) == 1 {
		if inner, exists := wrapper["output"]; exists {
			return inner
		}
	}
	return wrapper
}

// executionOutputs derives the per-step outputs and the workflow's final output
// from the runner state. The final output is the output of the last step that
// completed, so a run that failed part way still reports what it produced.
// Credential-shaped fields are stripped before anything is stored.
func executionOutputs(timeline []models.ExecutionStep, state map[string]interface{}) (map[string]interface{}, interface{}) {
	outputs := map[string]interface{}{}
	var final interface{}
	for _, step := range timeline {
		raw, ok := state[step.NodeID]
		if !ok {
			continue
		}
		value := withoutNestedSecretFields(stepOutputValue(raw))
		outputs[step.NodeID] = value
		if step.Status == models.StatusDone {
			final = value
		}
	}
	if len(outputs) == 0 {
		return nil, nil
	}
	return outputs, final
}

// attachStepOutputs copies each step's output onto its timeline entry so the
// timeline endpoint can show per-step results.
func attachStepOutputs(timeline []models.ExecutionStep, state map[string]interface{}) {
	for index := range timeline {
		raw, ok := state[timeline[index].NodeID]
		if !ok {
			continue
		}
		timeline[index].Output = withoutNestedSecretFields(stepOutputValue(raw))
	}
}

// classifyExecutionFailure turns a runner error into the additive failure
// record the UI needs to tell a governance block apart from a crashed tool.
// It never changes the execution status: both remain StatusFailed.
func (h *Handler) classifyExecutionFailure(blueprint models.WorkflowBlueprint, result runner.Result, runErr error, failedStep, failedTool string) *models.ExecutionFailure {
	failure := &models.ExecutionFailure{
		FailureCategory: models.FailureCategoryToolFailure,
		FailedStepID:    failedStep,
		FailedToolName:  failedTool,
		ToolWasCalled:   true,
	}

	var policyViolation *runner.ErrDispatchPolicyViolation
	if errors.As(runErr, &policyViolation) {
		failure.FailureCategory = models.FailureCategoryPolicyViolation
		failure.RuleID = policyViolation.RuleID
		failure.BlockedParameter = policyViolation.ParamKey
		// The gate refuses the step immediately before dispatch, so the tool
		// implementation was never reached.
		failure.ToolWasCalled = false
		failure.RuleMessage = h.validatorMessageForRule(policyViolation.RuleID)
		if policyViolation.StepIndex >= 0 && policyViolation.StepIndex < len(blueprint.Steps) {
			step := blueprint.Steps[policyViolation.StepIndex]
			failure.FailedStepID = step.ID
			failure.FailedToolName = step.Action
		}
		return failure
	}
	var dataEgressViolation *runner.ErrDataEgressViolation
	if errors.As(runErr, &dataEgressViolation) {
		failure.FailureCategory = models.FailureCategoryPolicyViolation
		failure.RuleID = dataEgressViolation.RuleID
		failure.BlockedParameter = dataEgressViolation.ParamKey
		failure.ToolWasCalled = false
		failure.RuleMessage = h.validatorMessageForRule(dataEgressViolation.RuleID)
		if dataEgressViolation.StepIndex >= 0 && dataEgressViolation.StepIndex < len(blueprint.Steps) {
			step := blueprint.Steps[dataEgressViolation.StepIndex]
			failure.FailedStepID = step.ID
			failure.FailedToolName = models.StepKindAnalysis
		}
		return failure
	}

	// The runner records a FAILED timeline entry only once a step has actually
	// been dispatched. No FAILED entry means execution stopped before any tool
	// was reached, e.g. an unregistered tool or a rejected validation token.
	if !hasFailedStep(result.Timeline) {
		failure.FailureCategory = models.FailureCategoryValidation
		failure.ToolWasCalled = false
		return failure
	}

	var downstream *tools.MCPHTTPError
	if errors.As(runErr, &downstream) {
		switch {
		case downstream.StatusCode == 400:
			failure.FailureCategory = models.FailureCategoryInvalidRequest
		case downstream.StatusCode == 401 || downstream.StatusCode == 403:
			failure.FailureCategory = models.FailureCategoryAuthDenied
		case downstream.StatusCode == 404:
			failure.FailureCategory = models.FailureCategoryNotFound
		case downstream.StatusCode >= 500 && downstream.StatusCode <= 599:
			failure.FailureCategory = models.FailureCategoryTransient
		default:
			// Unknown downstream statuses are terminal and retain TOOL_FAILURE.
		}
		return failure
	}

	if isTransientTransportFailure(runErr) {
		failure.FailureCategory = models.FailureCategoryTransient
	}
	return failure
}

func isTransientTransportFailure(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	var networkErr net.Error
	return errors.As(err, &networkErr)
}

func hasFailedStep(timeline []models.ExecutionStep) bool {
	for _, step := range timeline {
		if step.Status == models.StatusFailed {
			return true
		}
	}
	return false
}

// validatorMessageForRule returns the rule's own validator_message so the UI
// can explain the block in the registry's words rather than paraphrasing.
func (h *Handler) validatorMessageForRule(ruleID string) string {
	if strings.TrimSpace(ruleID) == "" {
		return ""
	}
	for _, rule := range h.activeRegistryRules() {
		if strings.EqualFold(rule.RuleID, ruleID) {
			return rule.ValidatorMessage
		}
	}
	return ""
}

// attachStepFailure copies the classification onto the failing timeline step so
// the step chip can render without consulting the parent execution.
func attachStepFailure(timeline []models.ExecutionStep, failure *models.ExecutionFailure) {
	if failure == nil {
		return
	}
	for index := range timeline {
		if timeline[index].Status == models.StatusFailed {
			timeline[index].Failure = failure
		}
	}
}

func executionFailureDetails(blueprint models.WorkflowBlueprint, result runner.Result, runErr error) (string, string, string) {
	index := len(result.Timeline)
	if index > 0 && result.Timeline[index-1].Status == models.StatusFailed {
		index--
	}
	if index >= len(blueprint.Steps) {
		index = len(blueprint.Steps) - 1
	}
	if index < 0 {
		return "unknown", "unknown", runErr.Error()
	}
	step := blueprint.Steps[index]
	if step.EffectiveKind() == models.StepKindAnalysis {
		return step.ID, models.StepKindAnalysis, runErr.Error()
	}
	return step.ID, step.Action, runErr.Error()
}

func (h *Handler) ListExecutions(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	user := h.currentUser(c)
	h.Store.Mu.RLock()
	items := make([]models.Execution, 0, len(h.Store.Executions))
	for _, execution := range h.Store.Executions {
		if !canReadExecution(user, execution) {
			continue
		}
		if workflowID := c.Query("workflowId"); workflowID != "" && execution.WorkflowID != workflowID {
			continue
		}
		if status := c.Query("status"); status != "" && execution.Status != status {
			continue
		}
		if query := strings.ToLower(strings.TrimSpace(c.Query("q"))); query != "" && !strings.Contains(strings.ToLower(execution.ID+" "+execution.WorkflowName), query) {
			continue
		}
		if cutoff := executionCutoff(c.Query("range"), time.Now().UTC()); !cutoff.IsZero() && execution.StartedAt.Before(cutoff) {
			continue
		}
		items = append(items, *execution)
	}
	h.Store.Mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].StartedAt.After(items[j].StartedAt) })
	paged, meta := paginate(items, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func executionCutoff(value string, now time.Time) time.Time {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "24h":
		return now.Add(-24 * time.Hour)
	case "7d":
		return now.Add(-7 * 24 * time.Hour)
	case "30d":
		return now.Add(-30 * 24 * time.Hour)
	default:
		return time.Time{}
	}
}

func (h *Handler) GetExecution(c *fiber.Ctx) error {
	execution, ok := h.executionForRead(c, c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Execution not found")
	}
	return c.JSON(models.OK(execution, "OK", nil))
}

func (h *Handler) ExecutionLogs(c *fiber.Ctx) error {
	if _, ok := h.executionForRead(c, c.Params("id")); !ok {
		return fiber.NewError(fiber.StatusNotFound, "Execution not found")
	}
	h.Store.Mu.RLock()
	logs := append([]models.ExecutionLog{}, h.Store.ExecutionLogs[c.Params("id")]...)
	h.Store.Mu.RUnlock()
	for index := range logs {
		logs[index].Metadata = withoutSecretFields(logs[index].Metadata)
	}
	return c.JSON(models.OK(logs, "OK", map[string]interface{}{"nextCursor": nil}))
}

func (h *Handler) ExecutionTimeline(c *fiber.Ctx) error {
	if _, ok := h.executionForRead(c, c.Params("id")); !ok {
		return fiber.NewError(fiber.StatusNotFound, "Execution not found")
	}
	h.Store.Mu.RLock()
	timeline := append([]models.ExecutionStep{}, h.Store.Timelines[c.Params("id")]...)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(timeline, "OK", nil))
}

func (h *Handler) ExecutionHealingReport(c *fiber.Ctx) error {
	if _, ok := h.executionForRead(c, c.Params("id")); !ok {
		return fiber.NewError(fiber.StatusNotFound, "Execution not found")
	}
	h.Store.Mu.RLock()
	report, ok := h.Store.Healing[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		report = models.HealingReport{ExecutionID: c.Params("id"), Status: "NO_HEALING_REQUIRED", Summary: "No self-healing event has been recorded for this execution.", Events: []map[string]interface{}{}, Metrics: map[string]interface{}{}}
	}
	return c.JSON(models.OK(report, "OK", nil))
}

func (h *Handler) CancelExecution(c *fiber.Ctx) error {
	return c.Status(fiber.StatusNotImplemented).JSON(models.Fail("Cancellation is unavailable while executions run synchronously", nil))
}

func (h *Handler) RetryExecution(c *fiber.Ctx) error {
	// A workflow:run_own caller may retry only an execution it is allowed to
	// read, i.e. one it started. executionForRead applies the same S4 scoping
	// as the execution detail endpoints; runWorkflowByID then re-applies
	// canRunWorkflow to the underlying workflow, so neither check is weakened.
	previous, ok := h.executionForRead(c, c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Execution not found")
	}
	var req models.RunWorkflowRequest
	_ = c.BodyParser(&req)
	return h.runWorkflowByID(c, previous.WorkflowID, req)
}

func (h *Handler) WorkflowExecutions(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	workflowID := c.Params("id")
	user := h.currentUser(c)
	workflow, ok := h.workflowByID(workflowID)
	if !ok || !canReadWorkflow(user, workflow) {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	h.Store.Mu.RLock()
	items := make([]models.Execution, 0, len(h.Store.Executions))
	for _, execution := range h.Store.Executions {
		if execution.WorkflowID == workflowID && canReadExecution(user, execution) {
			items = append(items, *execution)
		}
	}
	h.Store.Mu.RUnlock()
	paged, meta := paginate(items, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) executionForRead(c *fiber.Ctx, id string) (*models.Execution, bool) {
	user := h.currentUser(c)
	h.Store.Mu.RLock()
	execution, ok := h.Store.Executions[id]
	h.Store.Mu.RUnlock()
	if !ok || !canReadExecution(user, execution) {
		return nil, false
	}
	return execution, true
}

// updateWorkflowExecutionMetricsLocked derives workflow metrics from recorded
// executions. Store.Mu must be held by the caller.
func (h *Handler) updateWorkflowExecutionMetricsLocked(workflowID string, lastRun time.Time) {
	workflow := h.Store.Workflows[workflowID]
	if workflow == nil {
		return
	}
	finished, succeeded := 0, 0
	for _, execution := range h.Store.Executions {
		if execution.WorkflowID != workflowID {
			continue
		}
		if terminal, success := terminalExecutionOutcome(execution); terminal {
			finished++
			if success {
				succeeded++
			}
		}
	}
	workflow.LastRunAt = &lastRun
	workflow.SuccessRate = percentage(succeeded, finished)
	workflow.UpdatedAt = lastRun
}

func terminalExecutionOutcome(execution *models.Execution) (terminal, succeeded bool) {
	if execution == nil {
		return false, false
	}
	switch execution.Status {
	case models.StatusDone:
		return true, true
	case models.StatusFailed:
		return true, false
	case models.StatusPending, models.StatusRunning:
		return false, false
	default:
		return execution.CompletedAt != nil, false
	}
}

const restartFailureReason = "Execution failed because the process restarted mid-run."

// ReconcileOrphanedRunningExecutions resolves durable RUNNING records before
// the HTTP server accepts traffic. The store write lock also persists the
// reconciliation when PostgreSQL-backed state is configured.
func ReconcileOrphanedRunningExecutions(store *repository.Store, reconciledAt time.Time) int {
	if store == nil {
		return 0
	}
	reconciledAt = reconciledAt.UTC()
	store.Mu.Lock()
	defer store.Mu.Unlock()

	reconciled := 0
	workflows := map[string]struct{}{}
	for _, execution := range store.Executions {
		if execution == nil || execution.Status != models.StatusRunning {
			continue
		}
		execution.Status = models.StatusFailed
		completed := reconciledAt
		execution.CompletedAt = &completed
		execution.DurationMS = completed.Sub(execution.StartedAt).Milliseconds()
		if execution.DurationMS < 0 {
			execution.DurationMS = 0
		}
		store.ExecutionLogs[execution.ID] = append(store.ExecutionLogs[execution.ID], models.ExecutionLog{
			ID:          execution.ID + "_restart",
			ExecutionID: execution.ID,
			Timestamp:   reconciledAt,
			Level:       "error",
			Message:     restartFailureReason,
			Metadata:    map[string]interface{}{"reason": "process_restarted_mid_run"},
		})
		workflows[execution.WorkflowID] = struct{}{}
		reconciled++
	}
	for workflowID := range workflows {
		recalculateWorkflowExecutionMetricsLocked(store, workflowID, reconciledAt)
	}
	return reconciled
}

func recalculateWorkflowExecutionMetricsLocked(store *repository.Store, workflowID string, lastRun time.Time) {
	workflow := store.Workflows[workflowID]
	if workflow == nil {
		return
	}
	finished, succeeded := 0, 0
	for _, execution := range store.Executions {
		if execution.WorkflowID != workflowID {
			continue
		}
		if terminal, success := terminalExecutionOutcome(execution); terminal {
			finished++
			if success {
				succeeded++
			}
		}
	}
	workflow.LastRunAt = &lastRun
	workflow.SuccessRate = percentage(succeeded, finished)
	workflow.UpdatedAt = lastRun
}
