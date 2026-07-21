package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/handlers"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestAuthenticationMutationRateLimitUsesAPIEnvelope(t *testing.T) {
	app := fiber.New()
	handler := &handlers.Handler{
		Cfg:   config.Config{APIBasePath: "/api", JWTSecret: "rate-limit-test-secret"},
		Store: repository.NewStore(),
	}
	Register(app, handler)

	for attempt := 1; attempt <= 11; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", nil)
		response, err := app.Test(request)
		if err != nil {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
		if attempt <= 10 {
			response.Body.Close()
			if response.StatusCode == fiber.StatusTooManyRequests {
				t.Fatalf("attempt %d was limited too early", attempt)
			}
			continue
		}

		defer response.Body.Close()
		if response.StatusCode != fiber.StatusTooManyRequests {
			t.Fatalf("attempt %d status=%d, want 429", attempt, response.StatusCode)
		}
		var payload models.APIResponse
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			t.Fatalf("decode rate-limit response: %v", err)
		}
		if payload.Success || payload.Data != nil || payload.Message == "" {
			t.Fatalf("unexpected rate-limit envelope: %+v", payload)
		}
	}
}
