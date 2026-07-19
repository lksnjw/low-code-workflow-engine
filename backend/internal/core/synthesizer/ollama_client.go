package synthesizer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type OllamaClient struct {
	BaseURL string
	Model   string
	Enabled bool
	HTTP    *http.Client
}

type Service struct {
	Ollama   *OllamaClient
	Gemini   *GeminiClient
	Provider string
	Prompt   PromptBuilder
}

type Result struct {
	YAML       string                 `json:"yaml"`
	Confidence float64                `json:"confidence"`
	Usage      map[string]interface{} `json:"usage"`
}

func NewService(baseURL, model string, enabled bool) *Service {
	return &Service{
		Ollama: &OllamaClient{
			BaseURL: baseURL,
			Model:   model,
			Enabled: enabled,
			HTTP:    &http.Client{Timeout: 45 * time.Second},
		},
		Provider: "gemini",
		Prompt:   NewPromptBuilder(),
	}
}

func NewServiceWithProvider(baseURL, ollamaModel string, ollamaEnabled bool, provider, geminiAPIKey, geminiModel string) *Service {
	service := NewService(baseURL, ollamaModel, ollamaEnabled)
	service.Provider = strings.ToLower(strings.TrimSpace(provider))
	if service.Provider == "" {
		service.Provider = "gemini"
	}
	service.Gemini = NewGeminiClient(geminiAPIKey, geminiModel)
	return service
}

func (s *Service) Synthesize(ctx context.Context, userPrompt, mode, model string, context map[string]interface{}) (Result, error) {
	prompt := s.Prompt.Build(userPrompt, mode, context)
	yamlText, provider, err := s.generate(ctx, prompt, model)
	if err != nil {
		return Result{}, err
	}

	return Result{
		YAML:       yamlText,
		Confidence: 0,
		Usage: map[string]interface{}{
			"inputTokens":  0,
			"outputTokens": 0,
			"costUsd":      0.0,
			"provider":     provider,
			"measured":     false,
		},
	}, nil
}

func (s *Service) generate(ctx context.Context, prompt, overrideModel string) (string, string, error) {
	if strings.EqualFold(s.Provider, "gemini") {
		if s.Gemini == nil {
			return "", "gemini", fmt.Errorf("gemini client is not configured")
		}
		text, err := s.Gemini.Generate(ctx, prompt, overrideModel)
		return text, "gemini", err
	}
	if strings.EqualFold(s.Provider, "ollama") {
		if s.Ollama == nil {
			return "", "ollama", fmt.Errorf("ollama client is not configured")
		}
		text, err := s.Ollama.Generate(ctx, prompt, overrideModel)
		return text, "ollama", err
	}
	return "", s.Provider, fmt.Errorf("unsupported workflow-generation provider %q", s.Provider)
}

func (c *OllamaClient) Generate(ctx context.Context, prompt, overrideModel string) (string, error) {
	if !c.Enabled {
		return "", fmt.Errorf("ollama synthesis disabled")
	}

	model := c.Model
	if overrideModel != "" {
		model = overrideModel
	}

	body, err := json.Marshal(map[string]interface{}{
		"model":  model,
		"prompt": prompt,
		"stream": false,
		"options": map[string]interface{}{
			"temperature": 0.1,
		},
	})
	if err != nil {
		return "", fmt.Errorf("encode ollama request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create ollama request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("call ollama: %w", err)
	}
	defer resp.Body.Close()

	var payload struct {
		Response string `json:"response"`
		Error    string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode ollama response: %w", err)
	}
	if resp.StatusCode >= 400 || payload.Error != "" {
		return "", fmt.Errorf("ollama returned %d: %s", resp.StatusCode, payload.Error)
	}

	return payload.Response, nil
}
