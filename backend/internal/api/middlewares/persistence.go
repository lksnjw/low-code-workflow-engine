package middlewares

import (
	"context"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

// PersistenceFailureGuard turns a synchronous persistence failure observed
// during a mutating request into a retriable 503. Store rollback happens before
// the failure generation advances, so no success response is exposed for an
// in-memory mutation that was not durably committed.
func PersistenceFailureGuard(store *repository.Store) fiber.Handler {
	var mutationMu sync.Mutex
	return func(c *fiber.Ctx) error {
		if store == nil || !isMutationMethod(c.Method()) {
			return c.Next()
		}
		durable, _ := store.PersistenceStatus()
		if !durable {
			return c.Next()
		}
		// A single guard is installed for the app. Serializing mutating HTTP
		// requests makes the global failure generation attributable to the
		// request that observed it while leaving all reads concurrent.
		mutationMu.Lock()
		defer mutationMu.Unlock()
		if durable, healthy := store.PersistenceStatus(); durable && !healthy {
			probeContext, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			_, recovered := store.ProbePersistence(probeContext)
			cancel()
			if !recovered {
				return persistenceUnavailable(c)
			}
		}
		generationBefore := store.PersistenceFailureGeneration()
		err := c.Next()
		if store.PersistenceFailureGeneration() == generationBefore {
			return err
		}
		return persistenceUnavailable(c)
	}
}

func persistenceUnavailable(c *fiber.Ctx) error {
	return c.Status(fiber.StatusServiceUnavailable).JSON(models.Fail(
		"Storage persistence is unavailable; no mutation was committed and the request can be retried",
		nil,
	))
}

func isMutationMethod(method string) bool {
	switch method {
	case fiber.MethodPost, fiber.MethodPut, fiber.MethodPatch, fiber.MethodDelete:
		return true
	default:
		return false
	}
}
