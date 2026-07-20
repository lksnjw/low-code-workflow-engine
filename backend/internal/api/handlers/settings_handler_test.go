package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

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
