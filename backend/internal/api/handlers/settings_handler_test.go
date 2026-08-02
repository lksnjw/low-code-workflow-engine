package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func TestSecretClassificationCoversCredentialsWithoutHidingUsageMetrics(t *testing.T) {
	secretFields := []string{
		"apiKey", "client_secret", "password", "dbPassword", "access_token", "refreshToken",
		"oauthToken", "backupRefreshTokens", "bearer-token", "Authorization", "request_auth_header", "private_key", "credentials",
		"dbDSN", "database_url", "primaryRedisURL", "connection_string",
	}
	for _, key := range secretFields {
		if !isSecretField(key) {
			t.Errorf("isSecretField(%q) = false, want true", key)
		}
	}

	metricFields := []string{"inputTokens", "output_tokens", "tokenCount", "totalTokenCount", "maxTokens", "tokenUsage"}
	for _, key := range metricFields {
		if isSecretField(key) {
			t.Errorf("isSecretField(%q) = true, want false for usage/configuration metric", key)
		}
	}
}

func TestProbeEndpointRefusesRedirects(t *testing.T) {
	targetRequests := make(chan struct{}, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetRequests <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	result, err := probeEndpoint(http.MethodPost, redirector.URL, []byte(`{"credential":"must-not-hop"}`))
	if err == nil {
		t.Fatalf("probeEndpoint() result = %#v, error = nil; want redirect refusal", result)
	}
	if !strings.Contains(err.Error(), "HTTP 307") {
		t.Fatalf("probeEndpoint() error = %q, want redirect status only", err)
	}
	select {
	case <-targetRequests:
		t.Fatal("probeEndpoint followed redirect to the target")
	default:
	}
}

func TestPatchLLMSettingsDoesNotEchoSecretFields(t *testing.T) {
	store := repository.NewStore()
	handler := &Handler{Store: store}
	app := fiber.New()
	app.Get("/settings", handler.GetSettings)
	app.Patch("/settings", handler.PatchSettings)
	app.Get("/settings/llm", handler.GetLLMSettings)
	app.Patch("/settings/llm", handler.PatchLLMSettings)

	response := registryTestRequest(t, app, http.MethodPatch, "/settings/llm", "", map[string]interface{}{
		"model":  "gemini-test",
		"apiKey": "top-level-api-key",
		"provider": map[string]interface{}{
			"client_secret": "nested-client-secret",
			"region":        "test-region",
		},
		"fallbacks": []interface{}{
			map[string]interface{}{"API-KEY": "list-api-key", "model": "fallback-model"},
		},
	})
	defer response.Body.Close()

	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("PatchLLMSettings returned %d: %s", response.StatusCode, responseBody(t, response))
	}
	body := responseBody(t, response)
	assertNoSecretMaterial(t, "PatchLLMSettings", body)
	for _, expected := range []string{"gemini-test", "test-region", "fallback-model"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("PatchLLMSettings response omitted non-secret value %q: %s", expected, body)
		}
	}

	store.Mu.RLock()
	storedAPIKey := store.Settings.LLM["apiKey"]
	store.Mu.RUnlock()
	if storedAPIKey != "top-level-api-key" {
		t.Fatalf("PatchLLMSettings changed storage semantics; stored apiKey = %v", storedAPIKey)
	}

	getLLM := registryTestRequest(t, app, http.MethodGet, "/settings/llm", "", nil)
	getLLMBody := responseBody(t, getLLM)
	getLLM.Body.Close()
	if getLLM.StatusCode != fiber.StatusOK {
		t.Fatalf("GetLLMSettings returned %d: %s", getLLM.StatusCode, getLLMBody)
	}
	assertNoSecretMaterial(t, "GetLLMSettings", getLLMBody)

	getAll := registryTestRequest(t, app, http.MethodGet, "/settings", "", nil)
	getAllBody := responseBody(t, getAll)
	getAll.Body.Close()
	if getAll.StatusCode != fiber.StatusOK {
		t.Fatalf("GetSettings returned %d: %s", getAll.StatusCode, getAllBody)
	}
	assertNoSecretMaterial(t, "GetSettings", getAllBody)

	patchAll := registryTestRequest(t, app, http.MethodPatch, "/settings", "", map[string]interface{}{
		"llm": map[string]interface{}{"secondarySecret": "whole-settings-secret", "model": "updated-model"},
	})
	patchAllBody := responseBody(t, patchAll)
	patchAll.Body.Close()
	if patchAll.StatusCode != fiber.StatusOK {
		t.Fatalf("PatchSettings returned %d: %s", patchAll.StatusCode, patchAllBody)
	}
	assertNoSecretMaterial(t, "PatchSettings", patchAllBody)
	if !strings.Contains(patchAllBody, "updated-model") {
		t.Fatalf("PatchSettings response omitted non-secret update: %s", patchAllBody)
	}
}

func TestIntegrationResponsesDoNotEchoSecretConfig(t *testing.T) {
	store := repository.NewStore()
	handler := &Handler{Store: store}
	app := fiber.New()
	app.Post("/integrations", handler.CreateIntegration)
	app.Get("/integrations", handler.ListIntegrations)
	app.Get("/integrations/:id", handler.GetIntegration)
	app.Patch("/integrations/:id", handler.UpdateIntegration)

	created := registryTestRequest(t, app, http.MethodPost, "/integrations", "", map[string]interface{}{
		"name": "ERP", "type": "http",
		"config": map[string]interface{}{
			"baseUrl": "https://erp.example.test", "apiKey": "integration-secret",
			"auth": map[string]interface{}{"client_secret": "nested-secret", "region": "eu"},
		},
	})
	createdBody := responseBody(t, created)
	created.Body.Close()
	if created.StatusCode != fiber.StatusCreated {
		t.Fatalf("CreateIntegration returned %d: %s", created.StatusCode, createdBody)
	}
	assertIntegrationSecretRedacted(t, createdBody)

	store.Mu.RLock()
	var id string
	for candidateID, integration := range store.Integrations {
		id = candidateID
		if integration.Config["apiKey"] != "integration-secret" {
			t.Fatal("secret configuration was not retained server-side")
		}
	}
	store.Mu.RUnlock()

	for _, target := range []string{"/integrations", "/integrations/" + id} {
		response := registryTestRequest(t, app, http.MethodGet, target, "", nil)
		body := responseBody(t, response)
		response.Body.Close()
		if response.StatusCode != fiber.StatusOK {
			t.Fatalf("GET %s returned %d: %s", target, response.StatusCode, body)
		}
		assertIntegrationSecretRedacted(t, body)
	}

	updated := registryTestRequest(t, app, http.MethodPatch, "/integrations/"+id, "", map[string]interface{}{
		"config": map[string]interface{}{"access_secret": "replacement-secret", "region": "apac"},
	})
	updatedBody := responseBody(t, updated)
	updated.Body.Close()
	if updated.StatusCode != fiber.StatusOK {
		t.Fatalf("UpdateIntegration returned %d: %s", updated.StatusCode, updatedBody)
	}
	assertIntegrationSecretRedacted(t, updatedBody)
}

func TestSettingsConnectionFailuresDoNotLeakInternalErrors(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()

	core, observed := observer.New(zapcore.ErrorLevel)
	store := repository.NewStore()
	store.Webhooks["wh_failure"] = &models.Webhook{ID: "wh_failure", Name: "Failure", URL: upstream.URL}
	store.Integrations["int_failure"] = &models.Integration{
		ID: "int_failure", Name: "Failure", Type: "http", Config: map[string]interface{}{"baseUrl": upstream.URL},
	}
	handler := &Handler{Store: store, Log: zap.New(core)}
	app := fiber.New()
	app.Post("/settings/webhooks/:id/test", handler.TestWebhook)
	app.Post("/integrations/:id/test", handler.TestIntegration)
	app.Post("/integrations/:id/connect", handler.ConnectIntegration)

	for _, testCase := range []struct {
		path       string
		publicText string
	}{
		{"/settings/webhooks/wh_failure/test", "Webhook connection test failed"},
		{"/integrations/int_failure/test", "Integration connection test failed"},
		{"/integrations/int_failure/connect", "Integration connection failed"},
	} {
		response := registryTestRequest(t, app, http.MethodPost, testCase.path, "", nil)
		body := responseBody(t, response)
		response.Body.Close()
		if response.StatusCode != fiber.StatusBadGateway {
			t.Fatalf("POST %s status = %d, want 502: %s", testCase.path, response.StatusCode, body)
		}
		if !strings.Contains(body, testCase.publicText) {
			t.Fatalf("POST %s omitted stable public message %q: %s", testCase.path, testCase.publicText, body)
		}
		for _, forbidden := range []string{"endpoint returned HTTP 502", upstream.URL, `"error"`} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("POST %s leaked internal detail %q: %s", testCase.path, forbidden, body)
			}
		}
	}

	entries := observed.All()
	if len(entries) != 3 {
		t.Fatalf("detailed settings failures logged = %d, want 3", len(entries))
	}
	for _, entry := range entries {
		if !strings.Contains(fmt.Sprint(entry.ContextMap()["error"]), "endpoint returned HTTP 502") {
			t.Fatalf("backend log omitted the underlying error: %+v", entry.ContextMap())
		}
	}
}

func TestWebhookURLValidationDoesNotLeakInternalErrors(t *testing.T) {
	core, observed := observer.New(zapcore.ErrorLevel)
	store := repository.NewStore()
	store.Webhooks["wh_update"] = &models.Webhook{ID: "wh_update", Name: "Update", URL: "https://example.invalid"}
	handler := &Handler{Store: store, Log: zap.New(core)}
	app := fiber.New()
	app.Post("/settings/webhooks", handler.CreateWebhook)
	app.Patch("/settings/webhooks/:id", handler.UpdateWebhook)

	for _, testCase := range []struct {
		method string
		path   string
		body   map[string]interface{}
	}{
		{http.MethodPost, "/settings/webhooks", map[string]interface{}{"name": "Invalid", "url": "mailto:invalid"}},
		{http.MethodPatch, "/settings/webhooks/wh_update", map[string]interface{}{"url": "mailto:invalid"}},
	} {
		response := registryTestRequest(t, app, testCase.method, testCase.path, "", testCase.body)
		body := responseBody(t, response)
		response.Body.Close()
		if response.StatusCode != fiber.StatusBadRequest || !strings.Contains(body, "Webhook URL is invalid") {
			t.Fatalf("%s %s did not return the stable URL message: status=%d body=%s", testCase.method, testCase.path, response.StatusCode, body)
		}
		if strings.Contains(body, "a valid http or https URL is required") || strings.Contains(body, "mailto:invalid") {
			t.Fatalf("%s %s leaked URL validation detail: %s", testCase.method, testCase.path, body)
		}
	}
	if observed.Len() != 2 {
		t.Fatalf("URL validation failures logged = %d, want 2", observed.Len())
	}
}

func assertIntegrationSecretRedacted(t *testing.T, body string) {
	t.Helper()
	for _, forbidden := range []string{"integration-secret", "nested-secret", "replacement-secret", `"apiKey"`, `"client_secret"`, `"access_secret"`} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("integration response exposed %q: %s", forbidden, body)
		}
	}
	for _, expected := range []string{"baseUrl", "region"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("integration response omitted non-secret config %q: %s", expected, body)
		}
	}
}

func assertNoSecretMaterial(t *testing.T, endpoint, body string) {
	t.Helper()
	var payload interface{}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("%s response was not valid JSON: %v", endpoint, err)
	}
	assertNoSecretKeys(t, endpoint, payload)
	for _, forbidden := range []string{
		"top-level-api-key",
		"nested-client-secret",
		"list-api-key",
		"whole-settings-secret",
		`"apiKey"`,
		`"client_secret"`,
		`"API-KEY"`,
		`"secondarySecret"`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("%s response exposed secret field or value %q: %s", endpoint, forbidden, body)
		}
	}
}

func assertNoSecretKeys(t *testing.T, endpoint string, value interface{}) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, child := range typed {
			if isSecretField(key) {
				t.Fatalf("%s response exposed secret-classified key %q", endpoint, key)
			}
			assertNoSecretKeys(t, endpoint, child)
		}
	case []interface{}:
		for _, child := range typed {
			assertNoSecretKeys(t, endpoint, child)
		}
	}
}
