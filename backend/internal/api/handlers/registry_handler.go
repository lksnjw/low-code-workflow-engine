package handlers

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) AdminToolsRegistry(c *fiber.Ctx) error {
	if h.RegistryManager == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry manager is not configured")
	}
	items := h.RegistryManager.Tools()
	return c.JSON(models.OK(items, "Tool registry loaded", map[string]interface{}{"count": len(items), "registryHash": h.RegistryManager.Hash()}))
}

func (h *Handler) CreateRegistryTool(c *fiber.Ctx) error {
	result, err := h.RegistryManager.AddTool(c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.tool.created", result.Item.ToolID, result.OldHash, result.NewHash)
	return c.Status(fiber.StatusCreated).JSON(models.OK(result, "Tool schema created", nil))
}

func (h *Handler) UpdateRegistryTool(c *fiber.Ctx) error {
	result, err := h.RegistryManager.UpdateTool(c.Params("id"), c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.tool.updated", result.Item.ToolID, result.OldHash, result.NewHash)
	return c.JSON(models.OK(result, "Tool schema updated", nil))
}

func (h *Handler) AdminRulesRegistry(c *fiber.Ctx) error {
	if h.RegistryManager == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry manager is not configured")
	}
	items := h.RegistryManager.Rules()
	return c.JSON(models.OK(items, "Rule registry loaded", map[string]interface{}{"count": len(items), "registryHash": h.RegistryManager.Hash()}))
}

func (h *Handler) CreateRegistryRule(c *fiber.Ctx) error {
	result, err := h.RegistryManager.AddRule(c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.rule.created", result.Item.RuleID, result.OldHash, result.NewHash)
	return c.Status(fiber.StatusCreated).JSON(models.OK(result, "Rule created", nil))
}

func (h *Handler) UpdateRegistryRule(c *fiber.Ctx) error {
	result, err := h.RegistryManager.UpdateRule(c.Params("id"), c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.rule.updated", result.Item.RuleID, result.OldHash, result.NewHash)
	return c.JSON(models.OK(result, "Rule updated", nil))
}

func (h *Handler) auditRegistryMutation(c *fiber.Ctx, action, id, oldHash, newHash string) {
	user := h.currentUser(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	h.Store.Audit(
		principalFromUser(user),
		action,
		models.ResourceRef{Type: "registry", ID: id},
		map[string]interface{}{"registryHash": oldHash},
		map[string]interface{}{"registryHash": newHash, "semanticRebuildSuggested": true},
		c.IP(),
		c.Get("User-Agent"),
	)
}

func registryMutationError(err error) error {
	message := err.Error()
	switch {
	case strings.Contains(message, "was not found"):
		return fiber.NewError(fiber.StatusNotFound, message)
	case strings.Contains(message, "already exists"):
		return fiber.NewError(fiber.StatusConflict, message)
	default:
		return fiber.NewError(fiber.StatusUnprocessableEntity, message)
	}
}
