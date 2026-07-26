package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) GetRegistryContext(c *fiber.Ctx) error {
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	document, err := h.RegistryContext.Current()
	if err != nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is unavailable")
	}
	return c.JSON(models.OK(document, "Registry generation context loaded", nil))
}

func (h *Handler) RegenerateRegistryContext(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	document, err := h.RegistryContext.Regenerate()
	if err != nil {
		return fiber.NewError(fiber.StatusUnprocessableEntity, "Registry generation context could not be regenerated")
	}
	return c.JSON(models.OK(document, "Registry generation context regenerated", nil))
}

func (h *Handler) RegistryContextHistory(c *fiber.Ctx) error {
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	history, err := h.RegistryContext.History()
	if err != nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "Registry generation context history is unavailable")
	}
	return c.JSON(models.OK(history, "Registry generation context history loaded", map[string]interface{}{"count": len(history)}))
}
