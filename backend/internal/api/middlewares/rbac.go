package middlewares

import (
	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func RequirePermission(permission string, getPermissions func(*fiber.Ctx) []string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		for _, item := range getPermissions(c) {
			if item == permission {
				return c.Next()
			}
		}
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Permission denied", map[string]interface{}{"required": permission}))
	}
}

func RequireAnyPermission(permissions []string, getPermissions func(*fiber.Ctx) []string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		granted := getPermissions(c)
		for _, required := range permissions {
			for _, item := range granted {
				if item == required {
					return c.Next()
				}
			}
		}
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Permission denied", map[string]interface{}{"requiredAny": permissions}))
	}
}
