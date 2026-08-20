package synthesizer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func TestSynthesizeReportsGeminiUsageMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/models/gemini-2.5-flash:generateContent" {
			t.Errorf("Gemini request path = %q", request.URL.Path)
		}
		var body struct {
			GenerationConfig struct {
				Temperature float64 `json:"temperature"`
			} `json:"generationConfig"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode Gemini request: %v", err)
		} else if body.GenerationConfig.Temperature != 0 {
			t.Errorf("Gemini temperature = %v, want default 0", body.GenerationConfig.Temperature)
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{{
				"content": map[string]interface{}{
					"parts": []map[string]string{{"text": "name: measured_gemini"}},
				},
			}},
			"usageMetadata": map[string]int{
				"promptTokenCount":     37,
				"candidatesTokenCount": 11,
				"totalTokenCount":      48,
			},
		})
	}))
	defer server.Close()

	service := NewServiceWithProvider("", "", false, "gemini", "test-key", "gemini-2.5-flash")
	service.Gemini.BaseURL = server.URL
	service.Gemini.HTTP = server.Client()

	result, err := service.Synthesize(context.Background(), "generate a workflow", "balanced", "", nil)
	if err != nil {
		t.Fatalf("Synthesize returned an error: %v", err)
	}
	assertUsage(t, result.Usage, 37, 11, true)
	assertTemperature(t, result.Usage, 0)
}

func TestSynthesizeReportsOllamaUsageCounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/generate" {
			t.Errorf("Ollama request path = %q", request.URL.Path)
		}
		var body struct {
			Options struct {
				Temperature float64 `json:"temperature"`
			} `json:"options"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode Ollama request: %v", err)
		} else if body.Options.Temperature != 0 {
			t.Errorf("Ollama temperature = %v, want default 0", body.Options.Temperature)
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"response":          "name: measured_ollama",
			"prompt_eval_count": 29,
			"eval_count":        7,
		})
	}))
	defer server.Close()

	service := NewService(server.URL, "llama-test", true)
	service.Provider = "ollama"
	service.Ollama.HTTP = server.Client()

	result, err := service.Synthesize(context.Background(), "generate a workflow", "balanced", "", nil)
	if err != nil {
		t.Fatalf("Synthesize returned an error: %v", err)
	}
	assertUsage(t, result.Usage, 29, 7, true)
	assertTemperature(t, result.Usage, 0)
}

func TestGenerateCandidatesPreservesBatchUsageOnEveryCandidate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{{
				"content": map[string]interface{}{
					"parts": []map[string]string{{"text": "--- candidate_1 ---\nname: one\nsteps: []\n--- candidate_2 ---\nname: two\nsteps: []"}},
				},
			}},
			"usageMetadata": map[string]int{
				"promptTokenCount":     51,
				"candidatesTokenCount": 18,
			},
		})
	}))
	defer server.Close()

	service := NewServiceWithProvider("", "", false, "gemini", "test-key", "gemini-candidate-test")
	service.Gemini.BaseURL = server.URL
	service.Gemini.HTTP = server.Client()

	candidates, err := service.GenerateCandidates(context.Background(), CandidateGenerationRequest{
		Prompt:         "generate two workflows",
		UserRole:       "Client",
		CandidateCount: 2,
	})
	if err != nil {
		t.Fatalf("GenerateCandidates returned an error: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidate count = %d, want 2", len(candidates))
	}
	for _, candidate := range candidates {
		assertUsage(t, candidate.GenerationMetadata, 51, 18, true)
		if got := candidate.GenerationMetadata["provider"]; got != "gemini" {
			t.Errorf("candidate %s provider = %#v, want gemini", candidate.CandidateID, got)
		}
		if got := candidate.GenerationMetadata["model"]; got != "gemini-candidate-test" {
			t.Errorf("candidate %s model = %#v, want gemini-candidate-test", candidate.CandidateID, got)
		}
		assertTemperature(t, candidate.GenerationMetadata, 0)
	}
}

func TestSynthesizeReportsOpenAICompatibleUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/chat/completions" {
			t.Errorf("OpenAI-compatible request path = %q", request.URL.Path)
		}
		var body struct {
			Temperature float64 `json:"temperature"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode OpenAI-compatible request: %v", err)
		} else if body.Temperature != 0.25 {
			t.Errorf("OpenAI-compatible temperature = %v, want configured 0.25", body.Temperature)
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"choices": []map[string]interface{}{{
				"message": map[string]string{"content": "name: measured_openai"},
			}},
			"usage": map[string]int{
				"prompt_tokens":     43,
				"completion_tokens": 9,
				"total_tokens":      52,
			},
		})
	}))
	defer server.Close()

	service := NewService("", "", false)
	service.SetProviderResolver(func() (models.ProviderConfig, bool) {
		return models.ProviderConfig{
			Type:        "openai_compatible",
			BaseURL:     server.URL,
			Model:       "compatible-test-model",
			Temperature: 0.25,
			APIKey:      "test-key",
			Active:      true,
		}, true
	})

	result, err := service.Synthesize(context.Background(), "generate a workflow", "balanced", "", nil)
	if err != nil {
		t.Fatalf("Synthesize returned an error: %v", err)
	}
	assertUsage(t, result.Usage, 43, 9, true)
	assertTemperature(t, result.Usage, 0.25)
	if got := result.Usage["provider"]; got != "openai_compatible" {
		t.Errorf("provider = %#v, want openai_compatible", got)
	}
	if got := result.Usage["model"]; got != "compatible-test-model" {
		t.Errorf("model = %#v, want compatible-test-model", got)
	}
}

func TestSynthesizeDoesNotClaimUnreportedUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"response": "name: unmeasured_ollama",
		})
	}))
	defer server.Close()

	service := NewService(server.URL, "llama-test", true)
	service.Provider = "ollama"
	service.Ollama.HTTP = server.Client()

	result, err := service.Synthesize(context.Background(), "generate a workflow", "balanced", "", nil)
	if err != nil {
		t.Fatalf("Synthesize returned an error: %v", err)
	}
	assertUsage(t, result.Usage, 0, 0, false)
	assertTemperature(t, result.Usage, 0)
}

func assertUsage(t *testing.T, usage map[string]interface{}, inputTokens, outputTokens int, measured bool) {
	t.Helper()
	if got := usage["inputTokens"]; got != inputTokens {
		t.Errorf("inputTokens = %#v, want %d", got, inputTokens)
	}
	if got := usage["outputTokens"]; got != outputTokens {
		t.Errorf("outputTokens = %#v, want %d", got, outputTokens)
	}
	if got := usage["measured"]; got != measured {
		t.Errorf("measured = %#v, want %t", got, measured)
	}
	if got := usage["costUsd"]; got != float64(0) {
		t.Errorf("costUsd = %#v, want 0 without authoritative pricing", got)
	}
}

func assertTemperature(t *testing.T, usage map[string]interface{}, want float64) {
	t.Helper()
	if got := usage["temperature"]; got != want {
		t.Errorf("temperature = %#v, want %v", got, want)
	}
}
