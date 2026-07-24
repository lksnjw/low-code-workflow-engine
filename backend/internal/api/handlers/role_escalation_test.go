package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestSystemAdminCannotCreatePlatformAdminUser(t *testing.T) {
	store, handler, app := roleEscalationTestApp()
	app.Post("/users", handler.CreateUser)

	response := adminTestRequest(t, app, http.MethodPost, "/users", "system", map[string]interface{}{
		"name": "Escalated User", "email": "escalated@example.test", "password": "password123",
		"roleId": repository.RolePlatformAdminID,
	})
	body := readAdminResponse(t, response)
	if response.StatusCode != fiber.StatusForbidden || !strings.Contains(body, repository.RolePlatformAdminID) {
		t.Fatalf("status=%d body=%s, want 403 naming %s", response.StatusCode, body, repository.RolePlatformAdminID)
	}
	if len(store.Users) != 2 {
		t.Fatalf("forbidden user creation changed user count to %d", len(store.Users))
	}
}

func TestSystemAdminCannotPromoteUserToPlatformAdmin(t *testing.T) {
	store, handler, app := roleEscalationTestApp()
	store.Users["target"] = &models.User{ID: "target", RoleID: repository.RoleClientID, Status: "Active"}
	app.Put("/users/:id/role", handler.UpdateUserRole)

	response := adminTestRequest(t, app, http.MethodPut, "/users/target/role", "system", map[string]interface{}{
		"roleId": repository.RolePlatformAdminID,
	})
	body := readAdminResponse(t, response)
	if response.StatusCode != fiber.StatusForbidden || !strings.Contains(body, repository.RolePlatformAdminID) {
		t.Fatalf("status=%d body=%s, want 403 naming %s", response.StatusCode, body, repository.RolePlatformAdminID)
	}
	if store.Users["target"].AssignedRoleID() != repository.RoleClientID {
		t.Fatal("forbidden promotion changed the target role")
	}
}

func TestSystemAdminCannotCreateRoleWithPermissionsTheyLack(t *testing.T) {
	_, handler, app := roleEscalationTestApp()
	app.Post("/roles", handler.CreateRole)

	response := adminTestRequest(t, app, http.MethodPost, "/roles", "system", map[string]interface{}{
		"name": "Provider Operator", "permissions": []string{"user:manage", "provider:manage"},
	})
	body := readAdminResponse(t, response)
	if response.StatusCode != fiber.StatusForbidden || !strings.Contains(body, "provider:manage") {
		t.Fatalf("status=%d body=%s, want 403 naming provider:manage", response.StatusCode, body)
	}
}

func TestSystemAdminCannotAddUnheldPermissionToExistingRole(t *testing.T) {
	store, handler, app := roleEscalationTestApp()
	store.Roles["role_custom"] = &models.Role{
		ID: "role_custom", Name: "Custom", Permissions: []string{"registry:read"},
	}
	app.Put("/roles/:id", handler.UpdateRole)

	response := adminTestRequest(t, app, http.MethodPut, "/roles/role_custom", "system", map[string]interface{}{
		"permissions": []string{"registry:read", "settings:manage"},
	})
	body := readAdminResponse(t, response)
	if response.StatusCode != fiber.StatusForbidden || !strings.Contains(body, "settings:manage") {
		t.Fatalf("status=%d body=%s, want 403 naming settings:manage", response.StatusCode, body)
	}
	if containsString(store.Roles["role_custom"].Permissions, "settings:manage") {
		t.Fatal("forbidden permission was added to the role")
	}
}

func TestPlatformAdminCanGrantAnyPermission(t *testing.T) {
	store, handler, app := roleEscalationTestApp()
	app.Post("/roles", handler.CreateRole)
	permissions := make([]string, 0, len(store.Permissions))
	for _, permission := range store.Permissions {
		permissions = append(permissions, permission.Key)
	}

	response := adminTestRequest(t, app, http.MethodPost, "/roles", "platform", map[string]interface{}{
		"name": "Delegated Platform Role", "permissions": permissions,
	})
	assertAdminStatus(t, response, fiber.StatusCreated)
}

func TestEscalationRejectionNamesOffendingPermission(t *testing.T) {
	_, handler, app := roleEscalationTestApp()
	app.Post("/roles", handler.CreateRole)

	response := adminTestRequest(t, app, http.MethodPost, "/roles", "system", map[string]interface{}{
		"name": "Escalated Role", "permissions": []string{"registry:read", "registry:write"},
	})
	body := readAdminResponse(t, response)
	if response.StatusCode != fiber.StatusForbidden || !strings.Contains(body, "registry:write") {
		t.Fatalf("status=%d body=%s, want offending permission", response.StatusCode, body)
	}
}

func TestDeleteRoleWithHoldersReturns409WithCount(t *testing.T) {
	store, handler, app := roleEscalationTestApp()
	store.Roles["role_held"] = &models.Role{ID: "role_held", Name: "Held Role"}
	store.Users["holder-a"] = &models.User{ID: "holder-a", RoleID: "role_held", Status: "Active"}
	store.Users["holder-b"] = &models.User{ID: "holder-b", RoleID: "role_held", Status: "Suspended"}
	app.Delete("/roles/:id", handler.DeleteRole)

	response := adminTestRequest(t, app, http.MethodDelete, "/roles/role_held", "platform", nil)
	body := readAdminResponse(t, response)
	var payload struct {
		Meta struct {
			Holders int `json:"holders"`
		} `json:"meta"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusConflict || payload.Meta.Holders != 2 {
		t.Fatalf("status=%d holders=%d body=%s, want 409 with holders=2", response.StatusCode, payload.Meta.Holders, body)
	}
}

func TestBuiltInRoleDeleteRejected(t *testing.T) {
	_, handler, app := roleEscalationTestApp()
	app.Delete("/roles/:id", handler.DeleteRole)

	response := adminTestRequest(t, app, http.MethodDelete, "/roles/"+repository.RoleBuilderID, "platform", nil)
	body := readAdminResponse(t, response)
	if response.StatusCode != fiber.StatusConflict || !strings.Contains(body, "Built-in roles cannot be deleted") {
		t.Fatalf("status=%d body=%s, want built-in role conflict", response.StatusCode, body)
	}
}

func TestAllPermissionReadsUseDerivedSet(t *testing.T) {
	store, handler, app := roleEscalationTestApp()
	store.Users["system"].Permissions = []string{"registry:write"}
	effective, ok := store.EffectiveUser("system")
	if !ok || containsString(effective.Permissions, "registry:write") {
		t.Fatalf("effective permissions used a stored copy: %+v", effective)
	}

	app.Get("/middleware-check", middlewares.RequirePermission("registry:write", handler.Permissions), func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusOK)
	})
	app.Post("/registry/tools", handler.CreateRegistryTool)

	middlewareResponse := adminTestRequest(t, app, http.MethodGet, "/middleware-check", "system", nil)
	assertAdminStatus(t, middlewareResponse, fiber.StatusForbidden)
	handlerResponse := adminTestRequest(t, app, http.MethodPost, "/registry/tools", "system", map[string]interface{}{})
	assertAdminStatus(t, handlerResponse, fiber.StatusForbidden)
}

func roleEscalationTestApp() (*repository.Store, *Handler, *fiber.App) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{ID: "platform", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	store.Users["system"] = &models.User{ID: "system", RoleID: repository.RoleSystemAdminID, Status: "Active"}
	handler := &Handler{Store: store}
	return store, handler, testPrincipalApp("system")
}

func readAdminResponse(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
