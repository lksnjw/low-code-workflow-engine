package handlers

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestRegisterDefaultsSecondUserToClientRole(t *testing.T) {
	store := repository.NewStore()
	handler := &Handler{
		Cfg:   config.Config{JWTSecret: "test-secret", TokenTTL: time.Hour},
		Store: store,
	}
	app := fiber.New()
	app.Post("/register", handler.Register)

	register := func(name, email string) map[string]interface{} {
		t.Helper()
		body, _ := json.Marshal(map[string]string{
			"name": name, "email": email, "password": "password123",
		})
		request := httptest.NewRequest("POST", "/register", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response, err := app.Test(request)
		if err != nil {
			t.Fatalf("register %s: %v", email, err)
		}
		defer response.Body.Close()
		if response.StatusCode != fiber.StatusCreated {
			t.Fatalf("register %s returned %d", email, response.StatusCode)
		}
		var payload struct {
			Data struct {
				User map[string]interface{} `json:"user"`
			} `json:"data"`
		}
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			t.Fatalf("decode registration response: %v", err)
		}
		return payload.Data.User
	}

	first := register("Admin User", "admin@example.com")
	second := register("Client User", "client@example.com")

	if first["roleId"] != "role_admin" {
		t.Fatalf("first registration roleId = %v, want role_admin", first["roleId"])
	}
	if second["roleId"] != "role_client" {
		t.Fatalf("second registration roleId = %v, want role_client", second["roleId"])
	}
}
