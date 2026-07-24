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

func TestRegisterDefaultsNewUsersToClientRole(t *testing.T) {
	store := repository.NewStore()
	if created, err := store.BootstrapPlatformAdmin("admin@example.com", "admin-password"); err != nil || !created {
		t.Fatalf("bootstrap administrator: created=%t err=%v", created, err)
	}
	handler := &Handler{
		Cfg:   config.Config{JWTSecret: "test-secret", TokenTTL: time.Hour, AllowPublicRegistration: true},
		Store: store,
	}
	app := fiber.New()
	app.Post("/register", handler.Register)

	body, _ := json.Marshal(map[string]string{
		"name": "Client User", "email": "client@example.com", "password": "password123",
	})
	request := httptest.NewRequest("POST", "/register", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("register client: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusCreated {
		t.Fatalf("register client returned %d", response.StatusCode)
	}
	var payload struct {
		Data struct {
			User map[string]interface{} `json:"user"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode registration response: %v", err)
	}
	if payload.Data.User["roleId"] != repository.RoleClientID {
		t.Fatalf("registration roleId = %v, want %s", payload.Data.User["roleId"], repository.RoleClientID)
	}
	if len(store.Users) != 2 {
		t.Fatalf("user count=%d, want bootstrap administrator plus client", len(store.Users))
	}
}
