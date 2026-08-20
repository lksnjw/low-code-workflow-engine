package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
)

type MCPMode string

const (
	MCPModeRemote MCPMode = "remote"
	MCPModeMock   MCPMode = "mock"

	mockDemoEchoAction = "demo.echo"
)

type MCPClient struct {
	BaseURL string
	HTTP    *http.Client
	mode    MCPMode
}

// MCPHTTPError preserves only the downstream HTTP status. Response bodies are
// deliberately discarded below because they may contain credentials or
// internal diagnostics.
type MCPHTTPError struct {
	StatusCode int
}

func (e *MCPHTTPError) Error() string {
	return fmt.Sprintf("mcp middleware returned HTTP %d", e.StatusCode)
}

func NewMCPClient(baseURL string, timeout time.Duration) *MCPClient {
	return &MCPClient{
		BaseURL: baseURL,
		HTTP:    &http.Client{Timeout: timeout},
		mode:    MCPModeRemote,
	}
}

// SetMode selects how downstream MCP tool calls are transported. Remote is
// the default; mock must be enabled explicitly and only supports demo.echo.
func (c *MCPClient) SetMode(mode string) error {
	next := MCPMode(strings.ToLower(strings.TrimSpace(mode)))
	switch next {
	case MCPModeRemote, MCPModeMock:
		c.mode = next
		return nil
	default:
		return fmt.Errorf("unsupported MCP mode %q", mode)
	}
}

func (c *MCPClient) Execute(ctx context.Context, action string, capability workflowvalidator.DispatchCapability, params map[string]interface{}) (map[string]interface{}, error) {
	if !capability.IsUsable() {
		return nil, fmt.Errorf("dispatch capability is missing or invalid")
	}
	if capability.Action() != action {
		return nil, fmt.Errorf("dispatch capability action mismatch")
	}
	parameterJSON, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("encode resolved parameters for dispatch hash: %w", err)
	}
	parameterHash := workflowvalidator.ResolvedParameterHashBytes(parameterJSON)
	if parameterHash != capability.ResolvedParameterHash() {
		return nil, fmt.Errorf("dispatch capability resolved-parameter hash mismatch")
	}
	if c.mode == MCPModeMock {
		return executeMockMCP(action, params)
	}

	if c.BaseURL == "" {
		return nil, fmt.Errorf("MCP_BASE_URL is not configured; refusing to simulate tool %q", action)
	}

	body, err := json.Marshal(struct {
		Action     string          `json:"action"`
		Parameters json.RawMessage `json:"parameters"`
	}{
		Action:     action,
		Parameters: parameterJSON,
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

	if resp.StatusCode >= 400 {
		// Downstream error bodies are untrusted and may contain credentials,
		// request parameters, or internal diagnostics. Never propagate them
		// into runner errors or logs.
		return nil, &MCPHTTPError{StatusCode: resp.StatusCode}
	}

	var payload map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode mcp response: %w", err)
	}

	return payload, nil
}

func executeMockMCP(action string, params map[string]interface{}) (map[string]interface{}, error) {
	if action != mockDemoEchoAction {
		return nil, fmt.Errorf("MCP mock mode only supports %q; refusing tool %q", mockDemoEchoAction, action)
	}

	echo := make(map[string]interface{}, len(params))
	for key, value := range params {
		echo[key] = value
	}

	return map[string]interface{}{
		"action": action,
		"mock":   true,
		"echo":   echo,
	}, nil
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

func (t GenericMCPTool) Execute(ctx context.Context, capability workflowvalidator.DispatchCapability, params map[string]interface{}) (map[string]interface{}, error) {
	action := t.Action
	if action == "" {
		action = capability.Action()
	}
	return t.Client.Execute(ctx, action, capability, params)
}
