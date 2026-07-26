package handlers

import (
	"net/http"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestImportRequiresRegistryWritePermission(t *testing.T) {
	store := repository.NewStore()
	store.Users["client"] = &models.User{ID: "client", RoleID: repository.RoleClientID, Status: "Active"}
	handler := &Handler{Store: store}
	app := testPrincipalApp("client")
	registryWrite := middlewares.RequirePermission("registry:write", handler.Permissions)
	app.Post("/import/analyse", registryWrite, handler.AnalyseRegistryImport)
	app.Post("/import/commit", registryWrite, handler.CommitRegistryImport)
	app.Get("/import/history", registryWrite, handler.RegistryImportHistory)

	for _, route := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/import/analyse"},
		{http.MethodPost, "/import/commit"},
		{http.MethodGet, "/import/history"},
	} {
		response := adminTestRequest(t, app, route.method, route.path, "client", nil)
		response.Body.Close()
		if response.StatusCode != fiber.StatusForbidden {
			t.Fatalf("%s %s returned %d, want 403", route.method, route.path, response.StatusCode)
		}
	}
}

func TestSystemAdminCannotImport(t *testing.T) {
	store := repository.NewStore()
	store.Users["system"] = &models.User{ID: "system", RoleID: repository.RoleSystemAdminID, Status: "Active"}
	handler := &Handler{Store: store}
	app := testPrincipalApp("system")
	app.Post("/import/analyse", handler.AnalyseRegistryImport)
	app.Post("/import/commit", handler.CommitRegistryImport)
	app.Get("/import/history", handler.RegistryImportHistory)

	for _, route := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/import/analyse"},
		{http.MethodPost, "/import/commit"},
		{http.MethodGet, "/import/history"},
	} {
		response := adminTestRequest(t, app, route.method, route.path, "system", nil)
		response.Body.Close()
		if response.StatusCode != fiber.StatusForbidden {
			t.Fatalf("system admin %s %s returned %d, want 403", route.method, route.path, response.StatusCode)
		}
	}
}
