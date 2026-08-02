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

	generationcontext "github.com/sanjeewa/agentic-orchestrator/internal/core/context"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"go.uber.org/zap"
)

type OllamaClient struct {
	BaseURL string
	Model   string
	Enabled bool
	HTTP    *http.Client
}

type Service struct {
	Ollama          *OllamaClient
	Gemini          *GeminiClient
	Provider        string
	Prompt          PromptBuilder
	mu              sync.RWMutex
	resolver        func() (models.ProviderConfig, bool)
	registryContext *generationcontext.Service
	log             *zap.Logger
}

func (s *Service) SetProviderResolver(resolver func() (models.ProviderConfig, bool)) {
	s.mu.Lock()
	s.resolver = resolver
	s.mu.Unlock()
}

func (s *Service) SetRegistryContext(contextService *generationcontext.Service) {
	s.mu.Lock()
	s.registryContext = contextService
	s.mu.Unlock()
}

func (s *Service) SetLogger(log *zap.Logger) {
	s.mu.Lock()
	s.log = log
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
	yamlText, provider, selectedModel, usage, err := s.generateWithUsage(ctx, prompt, model)
	if err != nil {
		return Result{}, err
	}
	s.logPromptUsage("workflow_synthesis", provider, selectedModel, usage, len(prompt), contextItemCount(context, "tools"), contextItemCount(context, "rules"))

	return Result{
		YAML:       yamlText,
		Confidence: 0,
		Usage: map[string]interface{}{
			"inputTokens":  usage.InputTokens,
			"outputTokens": usage.OutputTokens,
			"costUsd":      0.0,
			"provider":     provider,
			"model":        selectedModel,
			"measured":     usage.Measured,
		},
	}, nil
}

func (s *Service) registryGenerationContext(domains []string) (string, error) {
	s.mu.RLock()
	contextService := s.registryContext
	s.mu.RUnlock()
	if contextService == nil {
		return "", nil
	}
	return contextService.PromptContext(domains)
}

func (s *Service) logPromptUsage(operation, provider, model string, usage providerUsage, promptBytes, toolCount, ruleCount int) {
	s.mu.RLock()
	log := s.log
	s.mu.RUnlock()
	if log == nil {
		return
	}
	log.Info("workflow generation provider usage",
		zap.String("operation", operation),
		zap.String("provider", provider),
		zap.String("model", model),
		zap.Int("prompt_tokens", usage.InputTokens),
		zap.Int("output_tokens", usage.OutputTokens),
		zap.Bool("measured", usage.Measured),
		zap.Int("prompt_bytes", promptBytes),
		zap.Int("retrieved_tool_count", toolCount),
		zap.Int("retrieved_rule_count", ruleCount),
	)
}

func contextItemCount(context map[string]interface{}, key string) int {
	if context == nil {
		return 0
	}
	switch items := context[key].(type) {
	case []interface{}:
		return len(items)
	case []string:
		return len(items)
	default:
		return 0
	}
}

func contextDomains(values map[string]interface{}) []string {
	if values == nil {
		return nil
	}
	out := []string{}
	switch value := values["domain"].(type) {
	case string:
		out = append(out, value)
	}
	switch value := values["domains"].(type) {
	case []string:
		out = append(out, value...)
	case []interface{}:
		for _, item := range value {
			if domain, ok := item.(string); ok {
				out = append(out, domain)
			}
		}
	}
	return out
}

func (s *Service) generate(ctx context.Context, prompt, overrideModel string) (string, string, string, error) {
	text, provider, model, _, err := s.generateWithUsage(ctx, prompt, overrideModel)
	return text, provider, model, err
}

func (s *Service) generateWithUsage(ctx context.Context, prompt, overrideModel string) (string, string, string, providerUsage, error) {
	if config, ok := s.activeProvider(); ok {
		return s.generateWithConfigUsage(ctx, config, prompt, overrideModel)
	}
	if strings.EqualFold(s.Provider, "gemini") {
		if s.Gemini == nil {
			return "", "gemini", "", providerUsage{}, fmt.Errorf("gemini client is not configured")
		}
		text, usage, err := s.Gemini.generateWithUsage(ctx, prompt, overrideModel)
		return text, "gemini", selectedModel(s.Gemini.Model, overrideModel), usage, err
	}
	if strings.EqualFold(s.Provider, "ollama") {
		if s.Ollama == nil {
			return "", "ollama", "", providerUsage{}, fmt.Errorf("ollama client is not configured")
		}
		text, usage, err := s.Ollama.generateWithUsage(ctx, prompt, overrideModel)
		return text, "ollama", selectedModel(s.Ollama.Model, overrideModel), usage, err
	}
	return "", s.Provider, "", providerUsage{}, fmt.Errorf("unsupported workflow-generation provider %q", s.Provider)
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
	text, provider, model, _, err := s.generateWithConfigUsage(ctx, config, prompt, overrideModel)
	return text, provider, model, err
}

func (s *Service) generateWithConfigUsage(ctx context.Context, config models.ProviderConfig, prompt, overrideModel string) (string, string, string, providerUsage, error) {
	model := selectedModel(config.Model, overrideModel)
	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "gemini":
		client := NewGeminiClient(config.APIKey, config.Model)
		if strings.TrimSpace(config.BaseURL) != "" {
			client.BaseURL = strings.TrimRight(config.BaseURL, "/")
		}
		text, usage, err := client.generateWithUsage(ctx, prompt, overrideModel)
		return text, "gemini", model, usage, err
	case "ollama":
		client := &OllamaClient{BaseURL: strings.TrimRight(config.BaseURL, "/"), Model: config.Model, Enabled: true, HTTP: &http.Client{Timeout: 45 * time.Second}}
		text, usage, err := client.generateWithUsage(ctx, prompt, overrideModel)
		return text, "ollama", model, usage, err
	case "openai_compatible":
		client := NewOpenAICompatibleClient(config.BaseURL, config.APIKey, config.Model)
		text, usage, err := client.generateWithUsage(ctx, prompt, overrideModel)
		return text, "openai_compatible", model, usage, err
	default:
		return "", config.Type, model, providerUsage{}, fmt.Errorf("unsupported workflow-generation provider %q", config.Type)
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
	text, _, err := c.generateWithUsage(ctx, prompt, overrideModel)
	return text, err
}

func (c *OllamaClient) generateWithUsage(ctx context.Context, prompt, overrideModel string) (string, providerUsage, error) {
	if !c.Enabled {
		return "", providerUsage{}, fmt.Errorf("ollama synthesis disabled")
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
		return "", providerUsage{}, fmt.Errorf("encode ollama request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return "", providerUsage{}, fmt.Errorf("create ollama request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", providerUsage{}, fmt.Errorf("call ollama: %w", err)
	}
	defer resp.Body.Close()

	var payload struct {
		Response        string `json:"response"`
		Error           string `json:"error"`
		PromptEvalCount *int   `json:"prompt_eval_count"`
		EvalCount       *int   `json:"eval_count"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", providerUsage{}, fmt.Errorf("decode ollama response: %w", err)
	}
	if resp.StatusCode >= 400 || payload.Error != "" {
		return "", providerUsage{}, fmt.Errorf("ollama returned %d: %s", resp.StatusCode, payload.Error)
	}

	usage := providerUsage{}
	if payload.PromptEvalCount != nil {
		usage.InputTokens = *payload.PromptEvalCount
	}
	if payload.EvalCount != nil {
		usage.OutputTokens = *payload.EvalCount
	}
	usage.Measured = payload.PromptEvalCount != nil && payload.EvalCount != nil
	return payload.Response, usage, nil
}
