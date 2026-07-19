package handlers

import (
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
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
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation before execution", fullValidation))
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
	h.Store.Executions[executionID] = execution
	h.Store.Mu.Unlock()

	runResult, err := h.Runner.Run(c.Context(), executionID, *workflow, req.Input, token)
	completed := time.Now().UTC()
	execution.CompletedAt = &completed
	execution.DurationMS = completed.Sub(now).Milliseconds()

	if err != nil {
		var policyViolation *runner.ErrDispatchPolicyViolation
		if errors.As(err, &policyViolation) {
			execution.Status = models.StatusFailed
		} else {
			execution.Status = models.StatusHealing
			repairedYAML, event, healErr := h.Healer.Repair(c.Context(), workflow.Name, workflow.YAML, err)
			if healErr == nil {
				_, repairValidation, validationErr := h.validateWithFullGate(c, "HealingRepair", repairedYAML)
				repairValid := validationErr == nil && repairValidation.Passed
				if event != nil {
					event["validation"] = repairValidation
				}
				h.Store.Mu.Lock()
				status := "REPAIRED_NOT_SAVED"
				summary := "Execution failed and self-healing generated YAML, but it did not pass full registry validation."
				if repairValid {
					workflow.YAML = repairedYAML
					status = "REPAIRED"
					summary = "Execution failed and the self-healing module generated a corrected YAML path that passed validation."
				}
				h.Store.Healing[executionID] = models.HealingReport{ExecutionID: executionID, WorkflowID: workflow.ID, Status: status, Summary: summary, Events: []map[string]interface{}{event}, Metrics: map[string]interface{}{}}
				h.Store.Mu.Unlock()
			} else {
				h.Store.Mu.Lock()
				h.Store.Healing[executionID] = models.HealingReport{ExecutionID: executionID, WorkflowID: workflow.ID, Status: "REPAIR_FAILED", Summary: "Execution failed and no validated repair could be generated.", Events: []map[string]interface{}{}, Metrics: map[string]interface{}{}}
				h.Store.Mu.Unlock()
			}
		}
	} else {
		execution.Status = models.StatusDone
	}

	h.Store.Mu.Lock()
	h.Store.Executions[executionID] = execution
	h.Store.ExecutionLogs[executionID] = append(h.Store.ExecutionLogs[executionID], runResult.Logs...)
	h.Store.Timelines[executionID] = append(h.Store.Timelines[executionID], runResult.Timeline...)
	h.updateWorkflowExecutionMetricsLocked(workflow.ID, completed)
	h.Store.Mu.Unlock()

	return c.JSON(models.OK(execution, "Execution completed", nil))
}

func (h *Handler) ListExecutions(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	h.Store.Mu.RLock()
	items := make([]models.Execution, 0, len(h.Store.Executions))
	for _, execution := range h.Store.Executions {
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
	h.Store.Mu.RLock()
	execution, ok := h.Store.Executions[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Execution not found")
	}
	return c.JSON(models.OK(execution, "OK", nil))
}

func (h *Handler) ExecutionLogs(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	logs := append([]models.ExecutionLog{}, h.Store.ExecutionLogs[c.Params("id")]...)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(logs, "OK", map[string]interface{}{"nextCursor": nil}))
}

func (h *Handler) ExecutionTimeline(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	timeline := append([]models.ExecutionStep{}, h.Store.Timelines[c.Params("id")]...)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(timeline, "OK", nil))
}

func (h *Handler) ExecutionHealingReport(c *fiber.Ctx) error {
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
	h.Store.Mu.RLock()
	previous, ok := h.Store.Executions[c.Params("id")]
	h.Store.Mu.RUnlock()
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
	h.Store.Mu.RLock()
	items := make([]models.Execution, 0, len(h.Store.Executions))
	for _, execution := range h.Store.Executions {
		if execution.WorkflowID == workflowID {
			items = append(items, *execution)
		}
	}
	h.Store.Mu.RUnlock()
	paged, meta := paginate(items, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
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
		if execution.Status == models.StatusDone {
			succeeded++
			finished++
		} else if execution.Status == models.StatusFailed {
			finished++
		}
	}
	workflow.LastRunAt = &lastRun
	workflow.SuccessRate = percentage(succeeded, finished)
	workflow.UpdatedAt = lastRun
}
