package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestSuspendedUserRejectedOnNextRequest(t *testing.T) {
	const (
		userID = "user_target"
		secret = "runtime-security-test-secret"
	)
	store := repository.NewStore()
	store.Users[userID] = &models.User{ID: userID, Name: "Target", Status: "Active", RoleID: repository.RoleClientID}
	store.Users["platform-admin"] = &models.User{ID: "platform-admin", Name: "Platform Admin", Status: "Active", RoleID: repository.RolePlatformAdminID}
	store.RefreshSessions["target-session-a"] = repository.RefreshSession{UserID: userID, ExpiresAt: time.Now().Add(time.Hour)}
	store.RefreshSessions["target-session-b"] = repository.RefreshSession{UserID: userID, ExpiresAt: time.Now().Add(time.Hour)}
	store.RefreshSessions["other-session"] = repository.RefreshSession{UserID: "other", ExpiresAt: time.Now().Add(time.Hour)}

	handler := &Handler{
		Cfg:   config.Config{JWTSecret: secret, TokenTTL: time.Hour},
		Store: store,
	}
	tokens, err := handler.tokenForUser(userID)
	if err != nil {
		t.Fatalf("sign access token: %v", err)
	}

	app := fiber.New()
	app.Get("/protected", middlewares.Auth(secret), handler.RequireUser, func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusNoContent)
	})
	app.Post("/users/:id/suspend", func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, "platform-admin")
		return c.Next()
	}, handler.SuspendUser)

	activeRequest := httptest.NewRequest(http.MethodGet, "/protected", nil)
	activeRequest.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	activeResponse, err := app.Test(activeRequest)
	if err != nil {
		t.Fatalf("active protected request: %v", err)
	}
	activeResponse.Body.Close()
	if activeResponse.StatusCode != fiber.StatusNoContent {
		t.Fatalf("active protected request returned %d, want 204", activeResponse.StatusCode)
	}

	suspendResponse, err := app.Test(httptest.NewRequest(http.MethodPost, "/users/"+userID+"/suspend", nil))
	if err != nil {
		t.Fatalf("suspend request: %v", err)
	}
	suspendResponse.Body.Close()
	if suspendResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("suspend request returned %d, want 200", suspendResponse.StatusCode)
	}

	store.Mu.RLock()
	for digest, session := range store.RefreshSessions {
		if session.UserID == userID {
			store.Mu.RUnlock()
			t.Fatalf("suspension retained refresh session %q", digest)
		}
	}
	_, otherSessionExists := store.RefreshSessions["other-session"]
	store.Mu.RUnlock()
	if !otherSessionExists {
		t.Fatal("suspension revoked another user's refresh session")
	}

	suspendedRequest := httptest.NewRequest(http.MethodGet, "/protected", nil)
	suspendedRequest.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	suspendedResponse, err := app.Test(suspendedRequest)
	if err != nil {
		t.Fatalf("suspended protected request: %v", err)
	}
	suspendedResponse.Body.Close()
	if suspendedResponse.StatusCode != fiber.StatusForbidden {
		t.Fatalf("suspended protected request returned %d, want 403", suspendedResponse.StatusCode)
	}
}
