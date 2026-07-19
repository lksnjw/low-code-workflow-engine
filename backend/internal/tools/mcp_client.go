package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type MCPClient struct {
	BaseURL string
	HTTP    *http.Client
}

func NewMCPClient(baseURL string, timeout time.Duration) *MCPClient {
	return &MCPClient{
		BaseURL: baseURL,
		HTTP:    &http.Client{Timeout: timeout},
	}
}

func (c *MCPClient) Execute(ctx context.Context, action string, params map[string]interface{}) (map[string]interface{}, error) {
	if c.BaseURL == "" {
		return nil, fmt.Errorf("MCP_BASE_URL is not configured; refusing to simulate tool %q", action)
	}

	body, err := json.Marshal(map[string]interface{}{
		"action":     action,
		"parameters": params,
	})
	if err != nil {
		return nil, fmt.Errorf("encode mcp request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/tools/execute", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create mcp request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call mcp middleware: %w", err)
	}
	defer resp.Body.Close()

	var payload map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode mcp response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("mcp middleware returned %d: %v", resp.StatusCode, payload)
	}

	return payload, nil
}

type GenericMCPTool struct {
	Action string
	Client *MCPClient
}

func (t GenericMCPTool) Name() string {
	if t.Action == "" {
		return "mcp"
	}
	return t.Action
}

func (t GenericMCPTool) Description() string {
	return "Generic MCP middleware bridge tool"
}

func (t GenericMCPTool) Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error) {
	action, _ := params["_action"].(string)
	if action == "" {
		action = t.Action
	}
	return t.Client.Execute(ctx, action, params)
}
