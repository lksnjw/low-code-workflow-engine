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

func TestFirstRegistrationRequiresConfiguredBootstrapToken(t *testing.T) {
	const bootstrapToken = "bootstrap-0123456789abcdef-0123456789abcdef"
	handler := &Handler{
		Cfg: config.Config{
			JWTSecret:           "test-registration-jwt-secret",
			TokenTTL:            time.Hour,
			BootstrapAdminToken: bootstrapToken,
		},
		Store: repository.NewStore(),
	}
	app := fiber.New()
	app.Post("/register", handler.Register)

	for _, item := range []struct {
		name  string
		token string
	}{
		{name: "missing"},
		{name: "wrong", token: "wrong-token"},
	} {
		t.Run(item.name, func(t *testing.T) {
			response := registrationRequest(t, app, item.token, "admin@example.test")
			defer response.Body.Close()
			if response.StatusCode != fiber.StatusForbidden {
				t.Fatalf("status=%d, want 403", response.StatusCode)
			}
			if len(handler.Store.Users) != 0 {
				t.Fatal("unauthorized bootstrap created a user")
			}
		})
	}

	response := registrationRequest(t, app, bootstrapToken, "admin@example.test")
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("authorized bootstrap status=%d, want 201", response.StatusCode)
	}
	if len(handler.Store.Users) != 1 {
		t.Fatalf("user count=%d, want 1", len(handler.Store.Users))
	}
	registeredUserID := ""
	for _, user := range handler.Store.Users {
		if user.Role.ID != "role_admin" {
			t.Fatalf("first user role=%q, want role_admin", user.Role.ID)
		}
		registeredUserID = user.ID
	}
	assignmentAudited := false
	for _, entry := range handler.Store.AuditLogs {
		if entry.Action == "user.role_assigned" && entry.Resource.ID == registeredUserID {
			assignmentAudited = true
			break
		}
	}
	if !assignmentAudited {
		t.Fatal("bootstrap Platform Admin role assignment was not audited")
	}
}

func TestLaterRegistrationHonorsPublicRegistrationSetting(t *testing.T) {
	handler := &Handler{
		Cfg: config.Config{
			Environment:             "production",
			JWTSecret:               "test-registration-jwt-secret",
			TokenTTL:                time.Hour,
			AllowPublicRegistration: false,
		},
		Store: repository.NewStore(),
	}
	app := fiber.New()
	app.Post("/register", handler.Register)

	first := registrationRequest(t, app, "", "admin@example.test")
	first.Body.Close()
	if first.StatusCode != fiber.StatusCreated {
		t.Fatalf("first registration status=%d, want 201", first.StatusCode)
	}

	second := registrationRequest(t, app, "", "client@example.test")
	defer second.Body.Close()
	if second.StatusCode != fiber.StatusForbidden {
		t.Fatalf("second registration status=%d, want 403", second.StatusCode)
	}
	if len(handler.Store.Users) != 1 {
		t.Fatalf("user count=%d, want 1", len(handler.Store.Users))
	}
}

func registrationRequest(t *testing.T, app *fiber.App, bootstrapToken, email string) *http.Response {
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
	if bootstrapToken != "" {
		request.Header.Set("X-Bootstrap-Token", bootstrapToken)
	}
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("registration request: %v", err)
	}
	return response
}
