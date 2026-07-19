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

type OpenAICompatibleClient struct {
	BaseURL string
	APIKey  string
	Model   string
	HTTP    *http.Client
}

func NewOpenAICompatibleClient(baseURL, apiKey, model string) *OpenAICompatibleClient {
	return &OpenAICompatibleClient{
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		APIKey:  strings.TrimSpace(apiKey),
		Model:   strings.TrimSpace(model),
		HTTP:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *OpenAICompatibleClient) Generate(ctx context.Context, prompt, overrideModel string) (string, error) {
	if c == nil || c.BaseURL == "" || c.APIKey == "" || c.Model == "" {
		return "", fmt.Errorf("openai-compatible provider is not fully configured")
	}
	body, err := json.Marshal(map[string]interface{}{
		"model":       selectedModel(c.Model, overrideModel),
		"messages":    []map[string]string{{"role": "user", "content": prompt}},
		"temperature": 0.1,
	})
	if err != nil {
		return "", fmt.Errorf("encode openai-compatible request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create openai-compatible request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.APIKey)
	response, err := c.HTTP.Do(request)
	if err != nil {
		return "", fmt.Errorf("openai-compatible request failed")
	}
	defer response.Body.Close()
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode openai-compatible response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("openai-compatible provider returned HTTP %d", response.StatusCode)
	}
	for _, choice := range payload.Choices {
		if text := strings.TrimSpace(choice.Message.Content); text != "" {
			return strings.TrimSpace(stripMarkdownFence(text)), nil
		}
	}
	return "", fmt.Errorf("openai-compatible provider returned no text choices")
}
