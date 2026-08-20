//go:build experiment

package handlers

import (
	"github.com/gofiber/fiber/v2"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) handleRejectedPlan(c *fiber.Ctx, workflow *models.Workflow, validation *workflowvalidator.CandidateValidationResult) (bool, error) {
	if !h.Runner.BaselineBEnabled() {
		return true, c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation before execution", validation))
	}
	userRole := "anonymous"
	if user := h.currentUser(c); user != nil {
		userRole = user.Role.Name
	}
	h.RegistryValidator.AuditBaselineBypass("plan.RunWorkflow", userRole, workflowvalidator.WorkflowContentHash(workflow.YAML), "plan_validation", "full registry validation would have blocked execution", map[string]interface{}{
		"failed_rules": append([]string{}, validation.FailedRules...),
		"errors":       append([]string{}, validation.Errors...),
	})
	return false, nil
}
