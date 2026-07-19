package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

func TestProviderSecretsAreWriteOnlyAndActivationAffectsNextSynthesis(t *testing.T) {
	providerA := openAIProviderServer("provider_a")
	defer providerA.Close()
	providerB := openAIProviderServer("provider_b")
	defer providerB.Close()

	store := repository.NewStore()
	store.Users["admin"] = &models.User{ID: "admin", Name: "Admin", Role: models.RoleRef{ID: "role_admin", Name: "Platform Admin"}, Permissions: []string{"settings:manage"}}
	store.Users["client"] = &models.User{ID: "client", Name: "Client", Role: models.RoleRef{ID: "role_client", Name: "Client"}, Permissions: []string{"workflow:read_own"}}
	synth := synthesizer.NewServiceWithProvider("", "", false, "gemini", "", "fallback")
	synth.SetProviderResolver(store.ActiveProvider)
	handler := &Handler{Store: store, Synth: synth, Log: zap.NewNop()}

	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		userID := c.Get("X-Test-User")
		if userID == "" {
			userID = "admin"
		}
		c.Locals(middlewares.UserIDKey, userID)
		return c.Next()
	})
	settingsManage := middlewares.RequirePermission("settings:manage", handler.Permissions)
	app.Get("/providers", settingsManage, handler.ListProviders)
	app.Post("/providers", settingsManage, handler.CreateProvider)
	app.Post("/providers/:id/activate", settingsManage, handler.ActivateProvider)
	app.Post("/providers/:id/test", settingsManage, handler.TestProvider)

	secretA := "aaaa-secret-one"
	secretB := "bbbb-secret-two"
	createA := registryTestRequest(t, app, http.MethodPost, "/providers", "admin", map[string]interface{}{
		"name": "Provider A", "type": "openai_compatible", "baseUrl": providerA.URL, "model": "model-a", "apiKey": secretA,
	})
	if createA.StatusCode != fiber.StatusCreated {
		t.Fatalf("create provider A returned %d: %s", createA.StatusCode, responseBody(t, createA))
	}
	createABody := responseBody(t, createA)
	createA.Body.Close()
	if strings.Contains(createABody, secretA) {
		t.Fatal("provider create response exposed the API key")
	}

	createB := registryTestRequest(t, app, http.MethodPost, "/providers", "admin", map[string]interface{}{
		"name": "Provider B", "type": "openai_compatible", "baseUrl": providerB.URL, "model": "model-b", "apiKey": secretB,
	})
	if createB.StatusCode != fiber.StatusCreated {
		t.Fatalf("create provider B returned %d: %s", createB.StatusCode, responseBody(t, createB))
	}
	createB.Body.Close()

	list := registryTestRequest(t, app, http.MethodGet, "/providers", "admin", nil)
	listBody := responseBody(t, list)
	list.Body.Close()
	if strings.Contains(listBody, secretA) || strings.Contains(listBody, secretB) {
		t.Fatal("provider GET response exposed an API key")
	}
	if !strings.Contains(listBody, "aaaa••••") || !strings.Contains(listBody, "bbbb••••") {
		t.Fatalf("provider GET response did not include safe key previews: %s", listBody)
	}

	first, err := synth.Synthesize(context.Background(), "generate", "test", "", nil)
	if err != nil || !strings.Contains(first.YAML, "provider_a") {
		t.Fatalf("first active provider was not used: result=%+v err=%v", first, err)
	}

	var providerBID string
	store.Mu.RLock()
	for id, provider := range store.Providers {
		if provider.Name == "Provider B" {
			providerBID = id
		}
	}
	store.Mu.RUnlock()
	if providerBID == "" {
		t.Fatal("provider B id was not stored")
	}
	activate := registryTestRequest(t, app, http.MethodPost, "/providers/"+providerBID+"/activate", "admin", nil)
	if activate.StatusCode != fiber.StatusOK {
		t.Fatalf("activate provider B returned %d", activate.StatusCode)
	}
	activate.Body.Close()

	second, err := synth.Synthesize(context.Background(), "generate", "test", "", nil)
	if err != nil || !strings.Contains(second.YAML, "provider_b") {
		t.Fatalf("newly active provider was not used by next call: result=%+v err=%v", second, err)
	}

	testResponse := registryTestRequest(t, app, http.MethodPost, "/providers/"+providerBID+"/test", "admin", nil)
	testBody := responseBody(t, testResponse)
	testResponse.Body.Close()
	if testResponse.StatusCode != fiber.StatusOK || !strings.Contains(testBody, `"ok":true`) {
		t.Fatalf("provider connectivity test failed: status=%d body=%s", testResponse.StatusCode, testBody)
	}

	forbidden := registryTestRequest(t, app, http.MethodGet, "/providers", "client", nil)
	if forbidden.StatusCode != fiber.StatusForbidden {
		t.Fatalf("client provider GET returned %d, want 403", forbidden.StatusCode)
	}
	forbidden.Body.Close()

	auditJSON, err := json.Marshal(store.AuditLogs)
	if err != nil {
		t.Fatalf("marshal audit records: %v", err)
	}
	if strings.Contains(string(auditJSON), secretA) || strings.Contains(string(auditJSON), secretB) {
		t.Fatal("provider API key was written to audit data")
	}
}

func openAIProviderServer(name string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"choices": []map[string]interface{}{{"message": map[string]string{"content": "name: " + name}}},
		})
	}))
}
