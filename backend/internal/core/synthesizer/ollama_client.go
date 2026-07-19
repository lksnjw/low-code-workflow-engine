package synthesizer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
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
	mu       sync.RWMutex
	resolver func() (models.ProviderConfig, bool)
}

func (s *Service) SetProviderResolver(resolver func() (models.ProviderConfig, bool)) {
	s.mu.Lock()
	s.resolver = resolver
	s.mu.Unlock()
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
	yamlText, provider, selectedModel, err := s.generate(ctx, prompt, model)
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
			"model":        selectedModel,
			"measured":     false,
		},
	}, nil
}

func (s *Service) generate(ctx context.Context, prompt, overrideModel string) (string, string, string, error) {
	if config, ok := s.activeProvider(); ok {
		return s.generateWithConfig(ctx, config, prompt, overrideModel)
	}
	if strings.EqualFold(s.Provider, "gemini") {
		if s.Gemini == nil {
			return "", "gemini", "", fmt.Errorf("gemini client is not configured")
		}
		text, err := s.Gemini.Generate(ctx, prompt, overrideModel)
		return text, "gemini", selectedModel(s.Gemini.Model, overrideModel), err
	}
	if strings.EqualFold(s.Provider, "ollama") {
		if s.Ollama == nil {
			return "", "ollama", "", fmt.Errorf("ollama client is not configured")
		}
		text, err := s.Ollama.Generate(ctx, prompt, overrideModel)
		return text, "ollama", selectedModel(s.Ollama.Model, overrideModel), err
	}
	return "", s.Provider, "", fmt.Errorf("unsupported workflow-generation provider %q", s.Provider)
}

func (s *Service) activeProvider() (models.ProviderConfig, bool) {
	s.mu.RLock()
	resolver := s.resolver
	s.mu.RUnlock()
	if resolver == nil {
		return models.ProviderConfig{}, false
	}
	config, ok := resolver()
	return config, ok && config.Active
}

func (s *Service) generateWithConfig(ctx context.Context, config models.ProviderConfig, prompt, overrideModel string) (string, string, string, error) {
	model := selectedModel(config.Model, overrideModel)
	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "gemini":
		client := NewGeminiClient(config.APIKey, config.Model)
		if strings.TrimSpace(config.BaseURL) != "" {
			client.BaseURL = strings.TrimRight(config.BaseURL, "/")
		}
		text, err := client.Generate(ctx, prompt, overrideModel)
		return text, "gemini", model, err
	case "ollama":
		client := &OllamaClient{BaseURL: strings.TrimRight(config.BaseURL, "/"), Model: config.Model, Enabled: true, HTTP: &http.Client{Timeout: 45 * time.Second}}
		text, err := client.Generate(ctx, prompt, overrideModel)
		return text, "ollama", model, err
	case "openai_compatible":
		client := NewOpenAICompatibleClient(config.BaseURL, config.APIKey, config.Model)
		text, err := client.Generate(ctx, prompt, overrideModel)
		return text, "openai_compatible", model, err
	default:
		return "", config.Type, model, fmt.Errorf("unsupported workflow-generation provider %q", config.Type)
	}
}

func (s *Service) TestProvider(ctx context.Context, config models.ProviderConfig) error {
	_, _, _, err := s.generateWithConfig(ctx, config, "Reply with the single word OK.", "")
	return err
}

func selectedModel(fallback, override string) string {
	if strings.TrimSpace(override) != "" {
		return strings.TrimSpace(override)
	}
	return strings.TrimSpace(fallback)
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
