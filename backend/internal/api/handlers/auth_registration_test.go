package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestRegistrationRefusesBeforeBootstrap(t *testing.T) {
	handler := &Handler{
		Cfg:   config.Config{JWTSecret: "test-registration-jwt-secret", TokenTTL: time.Hour, AllowPublicRegistration: true},
		Store: repository.NewStore(),
	}
	app := fiber.New()
	app.Post("/register", handler.Register)

	response := registrationRequest(t, app, "client@example.test")
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503", response.StatusCode)
	}
	if len(handler.Store.Users) != 0 {
		t.Fatal("registration bypassed first-run bootstrap")
	}
}

func TestLaterRegistrationHonorsPublicRegistrationSetting(t *testing.T) {
	store := repository.NewStore()
	if created, err := store.BootstrapPlatformAdmin("admin@example.test", "admin-password"); err != nil || !created {
		t.Fatalf("bootstrap administrator: created=%t err=%v", created, err)
	}
	handler := &Handler{
		Cfg: config.Config{
			Environment:             "production",
			JWTSecret:               "test-registration-jwt-secret",
			TokenTTL:                time.Hour,
			AllowPublicRegistration: false,
		},
		Store: store,
	}
	app := fiber.New()
	app.Post("/register", handler.Register)

	response := registrationRequest(t, app, "client@example.test")
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusForbidden {
		t.Fatalf("registration status=%d, want 403", response.StatusCode)
	}
	if len(handler.Store.Users) != 1 {
		t.Fatalf("user count=%d, want bootstrap administrator only", len(handler.Store.Users))
	}
}

func registrationRequest(t *testing.T, app *fiber.App, email string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"name":     "Registration Test",
		"email":    email,
		"password": "correct-horse-battery-staple",
	})
	if err != nil {
		t.Fatalf("marshal registration request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/register", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("registration request: %v", err)
	}
	return response
}
