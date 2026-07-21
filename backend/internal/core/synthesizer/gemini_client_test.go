package synthesizer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGeminiClientDefaultsToGemini25Flash(t *testing.T) {
	client := NewGeminiClient("test-key", "")
	if client.Model != "gemini-2.5-flash" {
		t.Fatalf("default Gemini model = %q, want gemini-2.5-flash", client.Model)
	}
}

func TestGeminiGenerateUsesHeaderAuthentication(t *testing.T) {
	const apiKey = "test-gemini-api-key"
	type capturedRequest struct {
		method     string
		requestURI string
		rawQuery   string
		headers    http.Header
	}
	requests := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests <- capturedRequest{method: request.Method, requestURI: request.RequestURI, rawQuery: request.URL.RawQuery, headers: request.Header.Clone()}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{{
				"content": map[string]interface{}{
					"parts": []map[string]string{{"text": "name: generated_workflow"}},
				},
			}},
		})
	}))
	defer server.Close()

	client := NewGeminiClient(apiKey, "gemini-test")
	client.BaseURL = server.URL
	client.HTTP = server.Client()

	result, err := client.Generate(context.Background(), "generate a workflow", "")
	if err != nil {
		t.Fatalf("Generate returned an error: %v", err)
	}
	if result != "name: generated_workflow" {
		t.Fatalf("Generate result = %q, want decoded candidate text", result)
	}

	captured := <-requests
	if captured.method != http.MethodPost {
		t.Fatalf("Gemini request method = %q, want POST", captured.method)
	}
	if captured.requestURI != "/models/gemini-test:generateContent" {
		t.Fatalf("Gemini request URI = %q, want model generateContent endpoint", captured.requestURI)
	}
	if captured.rawQuery != "" || strings.Contains(captured.requestURI, apiKey) {
		t.Fatalf("Gemini request exposed authentication in URL: %q", captured.requestURI)
	}
	if got := captured.headers.Get("x-goog-api-key"); got != apiKey {
		t.Fatalf("x-goog-api-key header = %q, want configured key", got)
	}
	for name, values := range captured.headers {
		if !strings.EqualFold(name, "x-goog-api-key") && strings.Contains(strings.Join(values, ","), apiKey) {
			t.Fatalf("Gemini key appeared in unexpected header %q", name)
		}
	}
}

func TestGeminiGenerateDoesNotForwardAPIKeyAcrossRedirect(t *testing.T) {
	const apiKey = "redirect-sensitive-api-key"
	redirectTargetRequests := make(chan http.Header, 1)
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		redirectTargetRequests <- request.Header.Clone()
		response.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", target.URL)
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	client := NewGeminiClient(apiKey, "gemini-test")
	client.BaseURL = redirector.URL
	client.HTTP = redirector.Client()
	_, err := client.Generate(context.Background(), "generate a workflow", "")
	if err == nil {
		t.Fatal("Gemini redirect unexpectedly produced a successful generation")
	}
	if strings.Contains(err.Error(), apiKey) {
		t.Fatal("Gemini redirect error exposed the API key")
	}

	select {
	case headers := <-redirectTargetRequests:
		t.Fatalf("Gemini client followed a redirect and forwarded headers, x-goog-api-key present=%t", headers.Get("x-goog-api-key") != "")
	default:
	}
}
