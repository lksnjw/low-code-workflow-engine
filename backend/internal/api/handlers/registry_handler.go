package handlers

import (
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func (h *Handler) AdminToolsRegistry(c *fiber.Ctx) error {
	if h.RegistryManager == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry manager is not configured")
	}
	items := h.RegistryManager.Tools()
	return c.JSON(models.OK(items, "Tool registry loaded", map[string]interface{}{"count": len(items), "registryHash": h.RegistryManager.Hash()}))
}

func (h *Handler) CreateRegistryTool(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	result, err := h.RegistryContext.AddTool(c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.tool.created", result.Item.ToolID, result.OldHash, result.NewHash)
	return c.Status(fiber.StatusCreated).JSON(models.OK(result, "Tool schema created", nil))
}

func (h *Handler) UpdateRegistryTool(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	result, err := h.RegistryContext.UpdateTool(c.Params("id"), c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.tool.updated", result.Item.ToolID, result.OldHash, result.NewHash)
	return c.JSON(models.OK(result, "Tool schema updated", nil))
}

func (h *Handler) ImportRegistryTools(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	allowUpdates, _ := strconv.ParseBool(c.Query("allowUpdates", "false"))
	result, entryErrors, err := h.RegistryContext.ImportTools(c.Body(), allowUpdates)
	if err != nil {
		return registryMutationError(err)
	}
	if len(entryErrors) > 0 {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.APIResponse{
			Success: false,
			Data: map[string]interface{}{
				"applied": false, "count": 0, "errors": entryErrors,
			},
			Message: "Tool import rejected; no registry entries were applied",
		})
	}
	h.auditRegistryBatchMutation(c, "registry.tools.imported", "tools", result.Count, result.IDs, result.OldHash, result.NewHash)
	return c.Status(fiber.StatusCreated).JSON(models.OK(map[string]interface{}{
		"applied": true, "count": result.Count, "ids": result.IDs, "errors": []coreregistry.BulkImportError{},
		"oldHash": result.OldHash, "newHash": result.NewHash, "semanticRebuildSuggested": result.SemanticRebuildSuggested,
	}, "Tool import applied atomically", nil))
}

func (h *Handler) AdminRulesRegistry(c *fiber.Ctx) error {
	if h.RegistryManager == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry manager is not configured")
	}
	items := h.RegistryManager.Rules()
	return c.JSON(models.OK(items, "Rule registry loaded", map[string]interface{}{"count": len(items), "registryHash": h.RegistryManager.Hash()}))
}

func (h *Handler) RegistryStatus(c *fiber.Ctx) error {
	if h.RegistryManager == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry manager is not configured")
	}
	toolPath, rulePath := h.RegistryManager.RegistryPaths()
	absoluteToolPath, toolPathErr := filepath.Abs(toolPath)
	absoluteRulePath, rulePathErr := filepath.Abs(rulePath)
	if toolPathErr != nil || rulePathErr != nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "active registry paths could not be resolved")
	}
	toolHash, err := config.RegistryFileSHA256(toolPath)
	if err != nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "active tool registry could not be hashed")
	}
	ruleHash, err := config.RegistryFileSHA256(rulePath)
	if err != nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "active rule registry could not be hashed")
	}
	writable := coreregistry.GuardRegistryWritePath(toolPath) == nil && coreregistry.GuardRegistryWritePath(rulePath) == nil
	mode := "read-only"
	if writable {
		mode = "runtime"
	}
	return c.JSON(models.OK(map[string]interface{}{
		"mode": mode, "writable": writable,
		"tools": map[string]interface{}{"path": absoluteToolPath, "sha256": toolHash},
		"rules": map[string]interface{}{"path": absoluteRulePath, "sha256": ruleHash},
	}, "Active registry status loaded", nil))
}

func (h *Handler) CreateRegistryRule(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	result, err := h.RegistryContext.AddRule(c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.rule.created", result.Item.RuleID, result.OldHash, result.NewHash)
	return c.Status(fiber.StatusCreated).JSON(models.OK(result, "Rule created", nil))
}

func (h *Handler) UpdateRegistryRule(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	result, err := h.RegistryContext.UpdateRule(c.Params("id"), c.Body())
	if err != nil {
		return registryMutationError(err)
	}
	h.auditRegistryMutation(c, "registry.rule.updated", result.Item.RuleID, result.OldHash, result.NewHash)
	return c.JSON(models.OK(result, "Rule updated", nil))
}

func (h *Handler) ImportRegistryRules(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.RegistryContext == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry generation context is not configured")
	}
	allowUpdates, _ := strconv.ParseBool(c.Query("allowUpdates", "false"))
	result, entryErrors, err := h.RegistryContext.ImportRules(c.Body(), allowUpdates)
	if err != nil {
		return registryMutationError(err)
	}
	if len(entryErrors) > 0 {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.APIResponse{
			Success: false,
			Data: map[string]interface{}{
				"applied": false, "count": 0, "errors": entryErrors,
			},
			Message: "Rule import rejected; no registry entries were applied",
		})
	}
	h.auditRegistryBatchMutation(c, "registry.rules.imported", "rules", result.Count, result.IDs, result.OldHash, result.NewHash)
	return c.Status(fiber.StatusCreated).JSON(models.OK(map[string]interface{}{
		"applied": true, "count": result.Count, "ids": result.IDs, "errors": []coreregistry.BulkImportError{},
		"oldHash": result.OldHash, "newHash": result.NewHash, "semanticRebuildSuggested": result.SemanticRebuildSuggested,
	}, "Rule import applied atomically", nil))
}

func (h *Handler) requireRegistryWrite(c *fiber.Ctx) error {
	user := h.currentUser(c)
	if user == nil {
		return fiber.NewError(fiber.StatusUnauthorized, "Authenticated user no longer exists")
	}
	if user.AssignedRoleID() == repository.RoleSystemAdminID || !containsString(user.Permissions, "registry:write") {
		return fiber.NewError(fiber.StatusForbidden, "Registry writes require Platform Admin authority")
	}
	if h.RegistryManager == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry manager is not configured")
	}
	toolPath, rulePath := h.RegistryManager.RegistryPaths()
	for _, path := range []string{toolPath, rulePath} {
		if err := coreregistry.GuardRegistryWritePath(path); err != nil {
			return fiber.NewError(fiber.StatusForbidden, "The frozen evaluation registry is read-only; registry writes require the active runtime registry")
		}
	}
	return nil
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

func (h *Handler) auditRegistryBatchMutation(c *fiber.Ctx, action, kind string, count int, ids []string, oldHash, newHash string) {
	user := h.currentUser(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	h.Store.Audit(
		principalFromUser(user),
		action,
		models.ResourceRef{Type: "registry", ID: kind},
		map[string]interface{}{"registryHash": oldHash},
		map[string]interface{}{
			"registryHash": newHash, "count": count, "ids": append([]string{}, ids...),
			"semanticRebuildSuggested": true,
		},
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
