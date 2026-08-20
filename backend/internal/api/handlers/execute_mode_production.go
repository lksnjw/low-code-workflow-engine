//go:build !experiment

package handlers

import (
	"github.com/gofiber/fiber/v2"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) handleRejectedPlan(c *fiber.Ctx, _ *models.Workflow, validation *workflowvalidator.CandidateValidationResult) (bool, error) {
	return true, c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation before execution", validation))
}
