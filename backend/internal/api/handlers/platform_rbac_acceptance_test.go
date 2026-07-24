package handlers

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestSystemAdminCannotReadProviderSecrets(t *testing.T) {
	store := repository.NewStore()
	store.Users["system"] = &models.User{ID: "system", RoleID: repository.RoleSystemAdminID, Status: "Active"}
	store.Providers["provider"] = &models.ProviderConfig{ID: "provider", Name: "Secret Provider", APIKey: "secret-value"}
	handler := &Handler{Store: store}
	app := testPrincipalApp("system")
	app.Get("/providers", handler.ListProviders)
	app.Post("/providers/:id/activate", handler.ActivateProvider)

	for _, request := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/providers"},
		{http.MethodPost, "/providers/provider/activate"},
	} {
		response := adminTestRequest(t, app, request.method, request.path, "system", nil)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != fiber.StatusForbidden {
			t.Fatalf("%s %s status=%d, want 403: %s", request.method, request.path, response.StatusCode, body)
		}
		if strings.Contains(string(body), "secret-value") || strings.Contains(string(body), "keyPreview") {
			t.Fatalf("forbidden provider response leaked credential data: %s", body)
		}
	}
}

func TestSystemAdminCannotWriteRegistry(t *testing.T) {
	store := repository.NewStore()
	store.Users["system"] = &models.User{ID: "system", RoleID: repository.RoleSystemAdminID, Status: "Active"}
	handler := &Handler{Store: store}
	app := testPrincipalApp("system")
	app.Post("/registry/tools", handler.CreateRegistryTool)
	app.Put("/registry/rules/:id", handler.UpdateRegistryRule)

	for _, request := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/registry/tools"},
		{http.MethodPut, "/registry/rules/example"},
	} {
		response := adminTestRequest(t, app, request.method, request.path, "system", map[string]interface{}{})
		assertAdminStatus(t, response, fiber.StatusForbidden)
	}
}

func TestBuiltInRolesCannotBeDeleted(t *testing.T) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{ID: "platform", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	handler := &Handler{Store: store}
	app := testPrincipalApp("platform")
	app.Delete("/roles/:id", handler.DeleteRole)

	for _, roleID := range []string{
		repository.RolePlatformAdminID,
		repository.RoleSystemAdminID,
		repository.RoleBuilderID,
		repository.RoleClientID,
	} {
		response := adminTestRequest(t, app, http.MethodDelete, "/roles/"+roleID, "platform", nil)
		assertAdminStatus(t, response, fiber.StatusConflict)
	}
}

func TestRoleInUseCannotBeDeleted(t *testing.T) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{ID: "platform", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	store.Roles["role_custom"] = &models.Role{ID: "role_custom", Name: "Custom"}
	store.Users["holder"] = &models.User{ID: "holder", RoleID: "role_custom", Status: "Active"}
	handler := &Handler{Store: store}
	app := testPrincipalApp("platform")
	app.Delete("/roles/:id", handler.DeleteRole)

	response := adminTestRequest(t, app, http.MethodDelete, "/roles/role_custom", "platform", nil)
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != fiber.StatusConflict || !strings.Contains(string(body), "1 user") {
		t.Fatalf("status=%d body=%s, want holder count conflict", response.StatusCode, body)
	}
}

func TestUserCannotChangeOwnRoleOrSuspendSelf(t *testing.T) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{ID: "platform", RoleID: repository.RolePlatformAdminID, Status: "Active"}
	handler := &Handler{Store: store}
	app := testPrincipalApp("platform")
	app.Put("/users/:id/role", handler.UpdateUserRole)
	app.Put("/users/:id/status", handler.UpdateUserStatus)

	roleResponse := adminTestRequest(t, app, http.MethodPut, "/users/platform/role", "platform", map[string]interface{}{"roleId": repository.RoleClientID})
	assertAdminStatus(t, roleResponse, fiber.StatusConflict)
	statusResponse := adminTestRequest(t, app, http.MethodPut, "/users/platform/status", "platform", map[string]interface{}{"status": "suspended"})
	assertAdminStatus(t, statusResponse, fiber.StatusConflict)
}

func testPrincipalApp(defaultUserID string) *fiber.App {
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		userID := c.Get("X-Test-User")
		if userID == "" {
			userID = defaultUserID
		}
		c.Locals(middlewares.UserIDKey, userID)
		return c.Next()
	})
	return app
}
