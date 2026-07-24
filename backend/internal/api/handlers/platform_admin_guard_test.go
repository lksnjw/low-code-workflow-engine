package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestCannotSuspendLastActivePlatformAdmin(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	app.Put("/users/:id/status", handler.UpdateUserStatus)

	response := adminTestRequest(t, app, http.MethodPut, "/users/platform/status", "platform", map[string]interface{}{"status": "suspended"})
	assertGuardResponse(t, response, fiber.StatusConflict, "At least one active Platform Admin must remain")
	if !strings.EqualFold(store.Users["platform"].Status, "active") {
		t.Fatal("last active Platform Admin was suspended")
	}
}

func TestCannotDemoteLastActivePlatformAdmin(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	app.Put("/users/:id/role", handler.UpdateUserRole)

	response := adminTestRequest(t, app, http.MethodPut, "/users/platform/role", "platform", map[string]interface{}{"roleId": repository.RoleClientID})
	assertGuardResponse(t, response, fiber.StatusConflict, "At least one active Platform Admin must remain")
	if store.Users["platform"].AssignedRoleID() != repository.RolePlatformAdminID {
		t.Fatal("last active Platform Admin was demoted")
	}
}

func TestCanSuspendPlatformAdminWhenAnotherActiveOneExists(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	store.Users["platform-2"] = &models.User{ID: "platform-2", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	app.Put("/users/:id/status", handler.UpdateUserStatus)

	response := adminTestRequest(t, app, http.MethodPut, "/users/platform-2/status", "platform", map[string]interface{}{"status": "suspended"})
	assertGuardResponse(t, response, fiber.StatusOK, "")
	if !strings.EqualFold(store.Users["platform-2"].Status, "suspended") {
		t.Fatal("second Platform Admin was not suspended")
	}
}

func TestSystemAdminCannotSuspendAnyPlatformAdmin(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	store.Users["platform-2"] = &models.User{ID: "platform-2", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	app.Put("/users/:id/status", handler.UpdateUserStatus)

	response := adminTestRequest(t, app, http.MethodPut, "/users/platform-2/status", "system", map[string]interface{}{"status": "suspended"})
	assertGuardResponse(t, response, fiber.StatusForbidden, "target Platform Admin outranks the caller")
}

func TestSystemAdminCannotDemoteAnyPlatformAdmin(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	store.Users["platform-2"] = &models.User{ID: "platform-2", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	app.Put("/users/:id/role", handler.UpdateUserRole)

	response := adminTestRequest(t, app, http.MethodPut, "/users/platform-2/role", "system", map[string]interface{}{"roleId": repository.RoleClientID})
	assertGuardResponse(t, response, fiber.StatusForbidden, "target Platform Admin outranks the caller")
}

func TestCannotRemovePermissionCallerDoesNotHold(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	store.Roles["role_custom"] = &models.Role{
		ID: "role_custom", Name: "Custom",
		Permissions: []string{"registry:read", "provider:manage"},
	}
	app.Put("/roles/:id", handler.UpdateRole)

	response := adminTestRequest(t, app, http.MethodPut, "/roles/role_custom", "system", map[string]interface{}{
		"permissions": []string{"registry:read"},
	})
	assertGuardResponse(t, response, fiber.StatusForbidden, `permission "provider:manage"`)
	if !containsString(store.Roles["role_custom"].Permissions, "provider:manage") {
		t.Fatal("permission the caller does not hold was removed")
	}
}

func TestPlatformAdminRoleFloorCannotBeRemoved(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	app.Put("/roles/:id", handler.UpdateRole)
	permissions := withoutPermission(store.Roles[repository.RolePlatformAdminID].Permissions, "registry:write")

	response := adminTestRequest(t, app, http.MethodPut, "/roles/"+repository.RolePlatformAdminID, "platform", map[string]interface{}{
		"permissions": permissions,
	})
	assertGuardResponse(t, response, fiber.StatusConflict, `Permission "registry:write" is required for the Platform Admin role`)
}

func TestCustomRoleHasNoPermissionFloor(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	store.Roles["role_custom"] = &models.Role{
		ID: "role_custom", Name: "Custom",
		Permissions: []string{"provider:manage", "registry:write", "user:manage", "settings:manage"},
	}
	app.Put("/roles/:id", handler.UpdateRole)

	response := adminTestRequest(t, app, http.MethodPut, "/roles/role_custom", "platform", map[string]interface{}{
		"permissions": []string{},
	})
	assertGuardResponse(t, response, fiber.StatusOK, "")
	if len(store.Roles["role_custom"].Permissions) != 0 {
		t.Fatalf("custom role retained a permission floor: %v", store.Roles["role_custom"].Permissions)
	}
}

func TestAdminCountDerivedFromLiveRoleAssignment(t *testing.T) {
	store, handler, app := platformAdminGuardApp()
	store.Users["not-platform"] = &models.User{
		ID: "not-platform", RoleID: repository.RoleClientID, Status: "Active",
		Role:        models.RoleRef{ID: repository.RolePlatformAdminID, Name: "Platform Admin"},
		Permissions: append([]string{}, store.Roles[repository.RolePlatformAdminID].Permissions...),
	}
	app.Put("/users/:id/status", handler.UpdateUserStatus)

	response := adminTestRequest(t, app, http.MethodPut, "/users/platform/status", "platform", map[string]interface{}{"status": "suspended"})
	assertGuardResponse(t, response, fiber.StatusConflict, "At least one active Platform Admin must remain")
}

func platformAdminGuardApp() (*repository.Store, *Handler, *fiber.App) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{ID: "platform", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	store.Users["system"] = &models.User{ID: "system", RoleID: repository.RoleSystemAdminID, Status: "Active"}
	handler := &Handler{Store: store}
	return store, handler, testPrincipalApp("platform")
}

func assertGuardResponse(t *testing.T, response *http.Response, status int, message string) {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("status=%d, want %d: %s", response.StatusCode, status, body)
	}
	if message != "" {
		var payload struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(payload.Message, message) {
			t.Fatalf("body=%s, want message containing %q", body, message)
		}
	}
}

func withoutPermission(permissions []string, removed string) []string {
	out := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		if permission != removed {
			out = append(out, permission)
		}
	}
	return out
}
