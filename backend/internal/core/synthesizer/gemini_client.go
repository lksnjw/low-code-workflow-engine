package synthesizer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type GeminiClient struct {
	APIKey  string
	Model   string
	BaseURL string
	HTTP    *http.Client
}

func NewGeminiClient(apiKey, model string) *GeminiClient {
	if strings.TrimSpace(model) == "" {
		model = "gemini-1.5-flash"
	}
	return &GeminiClient{
		APIKey:  strings.TrimSpace(apiKey),
		Model:   strings.TrimSpace(model),
		BaseURL: "https://generativelanguage.googleapis.com/v1beta",
		HTTP:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *GeminiClient) Generate(ctx context.Context, prompt, overrideModel string) (string, error) {
	if c == nil || c.APIKey == "" {
		return "", fmt.Errorf("gemini api key is not configured")
	}
	model := c.Model
	if strings.TrimSpace(overrideModel) != "" {
		model = strings.TrimSpace(overrideModel)
	}

	body, err := json.Marshal(map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"role": "user",
				"parts": []map[string]string{
					{"text": prompt},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"temperature":     0.1,
			"topP":            0.8,
			"maxOutputTokens": 8192,
		},
	})
	if err != nil {
		return "", fmt.Errorf("encode gemini request: %w", err)
	}

	endpoint := fmt.Sprintf("%s/models/%s:generateContent", strings.TrimRight(c.BaseURL, "/"), url.PathEscape(model))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create gemini request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", c.APIKey)

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	noRedirectClient := *httpClient
	noRedirectClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := noRedirectClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("gemini request failed")
	}
	defer resp.Body.Close()

	var payload struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		Error struct {
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode gemini response: %w", err)
	}
	if resp.StatusCode >= 400 || payload.Error.Message != "" {
		if payload.Error.Message == "" {
			payload.Error.Message = resp.Status
		}
		return "", fmt.Errorf("gemini returned HTTP %d", resp.StatusCode)
	}

	for _, candidate := range payload.Candidates {
		for _, part := range candidate.Content.Parts {
			if strings.TrimSpace(part.Text) != "" {
				return strings.TrimSpace(stripMarkdownFence(part.Text)), nil
			}
		}
	}
	return "", fmt.Errorf("gemini returned no text candidates")
}

func stripMarkdownFence(value string) string {
	text := strings.TrimSpace(value)
	if strings.HasPrefix(text, "```") {
		lines := strings.Split(text, "\n")
		if len(lines) >= 2 {
			lines = lines[1:]
			if strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
				lines = lines[:len(lines)-1]
			}
			text = strings.Join(lines, "\n")
		}
	}
	return strings.TrimSpace(text)
}
