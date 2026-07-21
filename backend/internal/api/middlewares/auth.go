package middlewares

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

const UserIDKey = "userID"

func Auth(secret string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		header := c.Get("Authorization")
		tokenText := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))

		// Browser WebSocket clients cannot set an Authorization header. Limit
		// query-token support to the WebSocket handshake route.
		if tokenText == "" && strings.HasPrefix(c.Path(), "/ws/") {
			tokenText = c.Query("token")
		}
		if tokenText == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Missing access token", nil))
		}

		token, err := jwt.Parse(tokenText, func(token *jwt.Token) (interface{}, error) {
			return []byte(secret), nil
		}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
		if err != nil || !token.Valid {
			return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Invalid or expired access token", nil))
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Invalid token claims", nil))
		}

		userID, _ := claims["sub"].(string)
		if userID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Invalid token subject", nil))
		}
		c.Locals(UserIDKey, userID)
		return c.Next()
	}
}
