package middlewares

import (
	"strconv"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

type rateLimitWindow struct {
	requests  int
	expiresAt time.Time
}

// RateLimit returns a process-local fixed-window limiter keyed by client IP and
// request path. Authentication routes use a shared instance, while the path in
// the key prevents a login attempt from consuming the registration allowance.
func RateLimit(maxRequests int, window time.Duration) fiber.Handler {
	var mu sync.Mutex
	windows := map[string]rateLimitWindow{}
	requestCount := uint64(0)

	return func(c *fiber.Ctx) error {
		now := time.Now()
		key := c.IP() + "|" + c.Path()

		mu.Lock()
		requestCount++
		if requestCount%1024 == 0 {
			for existingKey, existingWindow := range windows {
				if !now.Before(existingWindow.expiresAt) {
					delete(windows, existingKey)
				}
			}
		}

		current, exists := windows[key]
		if !exists || !now.Before(current.expiresAt) {
			current = rateLimitWindow{expiresAt: now.Add(window)}
		}
		current.requests++
		windows[key] = current
		limited := current.requests > maxRequests
		retryAfter := time.Until(current.expiresAt)
		mu.Unlock()

		if limited {
			retrySeconds := int(retryAfter.Seconds()) + 1
			if retrySeconds < 1 {
				retrySeconds = 1
			}
			c.Set(fiber.HeaderRetryAfter, strconv.Itoa(retrySeconds))
			return c.Status(fiber.StatusTooManyRequests).JSON(models.Fail("Too many authentication attempts; try again later", nil))
		}
		return c.Next()
	}
}
