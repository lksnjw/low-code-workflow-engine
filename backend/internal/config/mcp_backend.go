package config

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const MCPBackendMockERP = "mock-erp"

type MCPBackendInfo struct {
	Kind      string
	Service   string
	ToolCount int
}

// InspectMCPBackend reads the optional operational marker exposed by the
// standalone mock ERP. It does not affect MCP execution and does not require a
// bridge to implement /healthz.
func InspectMCPBackend(ctx context.Context, baseURL string) (MCPBackendInfo, error) {
	if strings.TrimSpace(baseURL) == "" {
		return MCPBackendInfo{}, fmt.Errorf("MCP_BASE_URL is empty")
	}
	endpoint, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return MCPBackendInfo{}, fmt.Errorf("parse MCP_BASE_URL: %w", err)
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/healthz"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return MCPBackendInfo{}, fmt.Errorf("create MCP health request: %w", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return MCPBackendInfo{}, fmt.Errorf("inspect MCP backend: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return MCPBackendInfo{}, fmt.Errorf("MCP health returned HTTP %d", response.StatusCode)
	}
	var payload struct {
		Service   string `json:"service"`
		ToolCount int    `json:"toolCount"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&payload); err != nil {
		return MCPBackendInfo{}, fmt.Errorf("decode MCP health: %w", err)
	}
	kind := "bridge"
	if strings.EqualFold(strings.TrimSpace(payload.Service), MCPBackendMockERP) {
		kind = MCPBackendMockERP
	}
	return MCPBackendInfo{Kind: kind, Service: payload.Service, ToolCount: payload.ToolCount}, nil
}
