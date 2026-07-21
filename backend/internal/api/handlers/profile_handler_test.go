package handlers

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestAPIKeySecretIsReturnedOnceAndNeverListed(t *testing.T) {
	handler := &Handler{Store: repository.NewStore()}
	app := fiber.New()
	app.Get("/api-keys", handler.ListAPIKeys)
	app.Post("/api-keys", handler.CreateAPIKey)

	created := registryTestRequest(t, app, http.MethodPost, "/api-keys", "", map[string]interface{}{
		"name": "automation", "scopes": []string{"workflow:run"},
	})
	createdBody := responseBody(t, created)
	created.Body.Close()
	if created.StatusCode != fiber.StatusCreated || !strings.Contains(createdBody, `"key":"wf_live_`) {
		t.Fatalf("CreateAPIKey did not return the one-time key: status=%d body=%s", created.StatusCode, createdBody)
	}

	listed := registryTestRequest(t, app, http.MethodGet, "/api-keys", "", nil)
	listedBody := responseBody(t, listed)
	listed.Body.Close()
	if listed.StatusCode != fiber.StatusOK {
		t.Fatalf("ListAPIKeys returned %d: %s", listed.StatusCode, listedBody)
	}
	if strings.Contains(listedBody, `"key"`) || strings.Contains(listedBody, "wf_live_") && !strings.Contains(listedBody, "wf_live_................") {
		t.Fatalf("ListAPIKeys exposed reusable key material: %s", listedBody)
	}
	if !strings.Contains(listedBody, `"maskedKey"`) {
		t.Fatalf("ListAPIKeys omitted the safe preview: %s", listedBody)
	}
}
