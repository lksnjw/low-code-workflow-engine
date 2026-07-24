package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestSystemAdminHierarchyRolePropagationAndAudit(t *testing.T) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{
		ID: "platform", Name: "Platform Owner", Email: "platform@example.test", Status: "Active",
		RoleID: repository.RolePlatformAdminID,
	}
	handler := &Handler{Store: store}
	app := newAdminHierarchyApp(handler)

	response := adminTestRequest(t, app, http.MethodPost, "/users", "platform", map[string]interface{}{
		"name": "System Operator", "email": "system@example.test", "password": "password123", "roleId": repository.RoleSystemAdminID,
	})
	assertAdminStatus(t, response, fiber.StatusCreated)
	systemUser := findUserByEmail(t, store, "system@example.test")

	createdIDs := []string{systemUser.ID}
	for _, item := range []struct {
		email  string
		roleID string
	}{
		{email: "builder@example.test", roleID: repository.RoleBuilderID},
		{email: "client@example.test", roleID: repository.RoleClientID},
	} {
		response = adminTestRequest(t, app, http.MethodPost, "/users", systemUser.ID, map[string]interface{}{
			"name": "Managed User", "email": item.email, "password": "password123", "roleId": item.roleID,
		})
		assertAdminStatus(t, response, fiber.StatusForbidden)
		response = adminTestRequest(t, app, http.MethodPost, "/users", "platform", map[string]interface{}{
			"name": "Managed User", "email": item.email, "password": "password123", "roleId": item.roleID,
		})
		assertAdminStatus(t, response, fiber.StatusCreated)
		createdIDs = append(createdIDs, findUserByEmail(t, store, item.email).ID)
	}

	for _, forbiddenRole := range []string{repository.RolePlatformAdminID, repository.RoleSystemAdminID} {
		response = adminTestRequest(t, app, http.MethodPost, "/users", systemUser.ID, map[string]interface{}{
			"name": "Forbidden User", "email": "forbidden-" + forbiddenRole + "@example.test", "password": "password123", "roleId": forbiddenRole,
		})
		assertAdminStatus(t, response, fiber.StatusForbidden)
	}

	response = adminTestRequest(t, app, http.MethodPatch, "/users/"+systemUser.ID, systemUser.ID, map[string]interface{}{"roleId": repository.RoleClientID})
	assertAdminStatus(t, response, fiber.StatusConflict)
	response = adminTestRequest(t, app, http.MethodDelete, "/users/platform", systemUser.ID, nil)
	assertAdminStatus(t, response, fiber.StatusForbidden)
	response = adminTestRequest(t, app, http.MethodPatch, "/users/platform/suspend", systemUser.ID, nil)
	assertAdminStatus(t, response, fiber.StatusForbidden)

	store.Mu.Lock()
	store.Roles["role_custom"] = &models.Role{ID: "role_custom", Name: "Custom Operator", Permissions: []string{"workflow:read"}}
	store.Users["custom-user"] = &models.User{
		ID: "custom-user", Name: "Custom User", Email: "custom@example.test", Status: "Active",
		RoleID: "role_custom",
	}
	store.Mu.Unlock()

	response = adminTestRequest(t, app, http.MethodGet, "/protected", "custom-user", nil)
	assertAdminStatus(t, response, fiber.StatusOK)
	response = adminTestRequest(t, app, http.MethodPatch, "/roles/role_custom", "platform", map[string]interface{}{"permissions": []string{}})
	assertAdminStatus(t, response, fiber.StatusOK)
	response = adminTestRequest(t, app, http.MethodGet, "/protected", "custom-user", nil)
	assertAdminStatus(t, response, fiber.StatusForbidden)

	effective, ok := store.EffectiveUser("custom-user")
	if !ok || len(effective.Permissions) != 0 {
		t.Fatalf("explicit empty role permissions were not effective for assigned user: %+v", effective)
	}
	response = adminTestRequest(t, app, http.MethodDelete, "/roles/role_custom", "platform", nil)
	assertAdminStatus(t, response, fiber.StatusConflict)
	response = adminTestRequest(t, app, http.MethodDelete, "/users/custom-user", "platform", nil)
	assertAdminStatus(t, response, fiber.StatusOK)
	response = adminTestRequest(t, app, http.MethodDelete, "/roles/role_custom", "platform", nil)
	assertAdminStatus(t, response, fiber.StatusOK)

	store.Mu.RLock()
	defer store.Mu.RUnlock()
	for _, userID := range createdIDs {
		found := false
		for _, entry := range store.AuditLogs {
			if entry.Action == "user.role_assigned" && entry.Resource.ID == userID {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("role assignment for user %s was not audited", userID)
		}
	}
}

func newAdminHierarchyApp(handler *Handler) *fiber.App {
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, c.Get("X-Test-User"))
		return c.Next()
	})
	manageUsers := middlewares.RequirePermission("user:manage", handler.Permissions)
	app.Post("/users", manageUsers, handler.CreateUser)
	app.Patch("/users/:id", manageUsers, handler.UpdateUser)
	app.Delete("/users/:id", manageUsers, handler.DeleteUser)
	app.Patch("/users/:id/suspend", manageUsers, handler.SuspendUser)
	app.Patch("/roles/:id", manageUsers, handler.UpdateRole)
	app.Delete("/roles/:id", manageUsers, handler.DeleteRole)
	app.Get("/protected", middlewares.RequirePermission("workflow:read", handler.Permissions), func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusOK)
	})
	return app
}

func adminTestRequest(t *testing.T, app *fiber.App, method, path, userID string, body interface{}) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("X-Test-User", userID)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func assertAdminStatus(t *testing.T, response *http.Response, expected int) {
	t.Helper()
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != expected {
		t.Fatalf("status=%d, want %d: %s", response.StatusCode, expected, strings.TrimSpace(string(raw)))
	}
}

func findUserByEmail(t *testing.T, store *repository.Store, email string) *models.User {
	t.Helper()
	store.Mu.RLock()
	defer store.Mu.RUnlock()
	for _, user := range store.Users {
		if strings.EqualFold(user.Email, email) {
			copyUser := *user
			return &copyUser
		}
	}
	t.Fatalf("user %q was not created", email)
	return nil
}
