package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestMCPClientDefaultModeRequiresRemoteURL(t *testing.T) {
	client := NewMCPClient("", time.Second)
	params := map[string]interface{}{"message": "hello"}
	capability := mintTestDispatchCapability(t, mockDemoEchoAction, params)

	result, err := client.Execute(context.Background(), mockDemoEchoAction, capability, params)
	if err == nil {
		t.Fatal("Execute() error = nil, want missing MCP_BASE_URL error")
	}
	if result != nil {
		t.Fatalf("Execute() result = %#v, want nil", result)
	}
	if !strings.Contains(err.Error(), "MCP_BASE_URL is not configured") {
		t.Fatalf("Execute() error = %q, want missing MCP_BASE_URL error", err)
	}
}

func TestMCPClientMockModeExecutesDemoEchoDeterministically(t *testing.T) {
	client := NewMCPClient("", time.Second)
	if err := client.SetMode("mock"); err != nil {
		t.Fatalf("SetMode(mock) error = %v", err)
	}

	params := map[string]interface{}{"message": "hello", "count": float64(2)}
	capability := mintTestDispatchCapability(t, mockDemoEchoAction, params)
	want := map[string]interface{}{
		"action": mockDemoEchoAction,
		"mock":   true,
		"echo":   map[string]interface{}{"message": "hello", "count": float64(2)},
	}

	first, err := client.Execute(context.Background(), mockDemoEchoAction, capability, params)
	if err != nil {
		t.Fatalf("first Execute() error = %v", err)
	}
	second, err := client.Execute(context.Background(), mockDemoEchoAction, capability, params)
	if err != nil {
		t.Fatalf("second Execute() error = %v", err)
	}
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("first Execute() result = %#v, want %#v", first, want)
	}
	if !reflect.DeepEqual(second, want) {
		t.Fatalf("second Execute() result = %#v, want %#v", second, want)
	}

	params["message"] = "changed"
	if first["echo"].(map[string]interface{})["message"] != "hello" {
		t.Fatal("mock result aliases the caller's parameter map")
	}
}

func TestMCPClientMockModeRefusesNonDemoAction(t *testing.T) {
	client := NewMCPClient("", time.Second)
	if err := client.SetMode("mock"); err != nil {
		t.Fatalf("SetMode(mock) error = %v", err)
	}

	capability := mintTestDispatchCapability(t, "send_webhook", nil)
	result, err := client.Execute(context.Background(), "send_webhook", capability, nil)
	if err == nil {
		t.Fatal("Execute() error = nil, want unsupported mock action error")
	}
	if result != nil {
		t.Fatalf("Execute() result = %#v, want nil", result)
	}
	if !strings.Contains(err.Error(), `only supports "demo.echo"`) {
		t.Fatalf("Execute() error = %q, want demo.echo-only error", err)
	}
}

func TestMCPClientRemoteModePostsToMiddleware(t *testing.T) {
	type requestPayload struct {
		Action     string                 `json:"action"`
		Parameters map[string]interface{} `json:"parameters"`
	}

	var received requestPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("request method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/tools/execute" {
			t.Errorf("request path = %s, want /tools/execute", r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"source":"remote"}`))
	}))
	defer server.Close()

	client := NewMCPClient(server.URL, time.Second)
	params := map[string]interface{}{"message": "through HTTP"}
	capability := mintTestDispatchCapability(t, mockDemoEchoAction, params)
	result, err := client.Execute(context.Background(), mockDemoEchoAction, capability, params)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}

	if received.Action != mockDemoEchoAction {
		t.Fatalf("request action = %q, want %q", received.Action, mockDemoEchoAction)
	}
	if !reflect.DeepEqual(received.Parameters, params) {
		t.Fatalf("request parameters = %#v, want %#v", received.Parameters, params)
	}
	if result["ok"] != true || result["source"] != "remote" {
		t.Fatalf("Execute() result = %#v, want remote response", result)
	}
}

func TestMCPClientRemoteErrorDoesNotExposeDownstreamPayload(t *testing.T) {
	const downstreamSecret = "downstream-private-token-123"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"provider rejected ` + downstreamSecret + `","authorization":"Bearer sensitive"}`))
	}))
	defer server.Close()

	client := NewMCPClient(server.URL, time.Second)
	params := map[string]interface{}{"message": "hello"}
	capability := mintTestDispatchCapability(t, mockDemoEchoAction, params)
	result, err := client.Execute(context.Background(), mockDemoEchoAction, capability, params)
	if err == nil {
		t.Fatalf("Execute() result = %#v, error = nil; want downstream HTTP error", result)
	}
	if result != nil {
		t.Fatalf("Execute() result = %#v, want nil", result)
	}
	if !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("Execute() error = %q, want downstream status", err)
	}
	for _, forbidden := range []string{downstreamSecret, "provider rejected", "Bearer sensitive", "authorization"} {
		if strings.Contains(err.Error(), forbidden) {
			t.Fatalf("Execute() error exposed downstream payload %q: %v", forbidden, err)
		}
	}
}

type countingTransport struct {
	calls int
}

func (s *countingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	s.calls++
	return nil, fmt.Errorf("unexpected HTTP request")
}

func TestMCPClientZeroValueCapabilityMakesNoHTTPRequest(t *testing.T) {
	transport := &countingTransport{}
	client := NewMCPClient("https://bridge.invalid", time.Second)
	client.HTTP = &http.Client{Transport: transport}

	result, err := client.Execute(context.Background(), mockDemoEchoAction, workflowvalidator.DispatchCapability{}, map[string]interface{}{"message": "hello"})
	if err == nil || !strings.Contains(err.Error(), "capability is missing or invalid") {
		t.Fatalf("expected zero-capability rejection, result=%#v err=%v", result, err)
	}
	if transport.calls != 0 {
		t.Fatalf("zero capability made %d HTTP requests", transport.calls)
	}
}

func TestMCPClientMutatedParametersFailHashWithoutHTTPRequest(t *testing.T) {
	transport := &countingTransport{}
	client := NewMCPClient("https://bridge.invalid", time.Second)
	client.HTTP = &http.Client{Transport: transport}
	params := map[string]interface{}{"amount": float64(25)}
	capability := mintTestDispatchCapability(t, mockDemoEchoAction, params)
	params["amount"] = float64(25000)

	result, err := client.Execute(context.Background(), mockDemoEchoAction, capability, params)
	if err == nil || !strings.Contains(err.Error(), "resolved-parameter hash mismatch") {
		t.Fatalf("expected mutated-parameter rejection, result=%#v err=%v", result, err)
	}
	if transport.calls != 0 {
		t.Fatalf("parameter mismatch made %d HTTP requests", transport.calls)
	}
}

func mintTestDispatchCapability(t *testing.T, action string, params map[string]interface{}) workflowvalidator.DispatchCapability {
	t.Helper()
	toolRegistry := coreregistry.NewToolRegistry([]coreregistry.Tool{{
		ToolID: "TEST-MCP-TOOL", Name: action, Status: "active_mcp_schema_present",
		AllowedRoles: []string{"Workflow Builder"}, RiskLevel: "low", IsReadOnly: true,
	}}, "tools-v1")
	gate := workflowvalidator.NewRegistryValidator(toolRegistry, coreregistry.NewRuleRegistry(nil, "rules-v1"), repository.NewStore())
	rawYAML := fmt.Sprintf("name: mcp_test\ndescription: Mint a capability for an MCP client test.\ntrigger:\n  type: manual\nsteps:\n  - id: dispatch\n    action: %s\n    parameters: {}\n", action)
	token, result, err := gate.ValidateAndIssueToken("mcp-test", rawYAML, "Workflow Builder")
	if err != nil || !result.Passed || token == nil {
		t.Fatalf("mint prerequisite validation failed: result=%+v token=%+v err=%v", result, token, err)
	}
	capability, violation := gate.EvaluateResolvedStep("mcp-test.dispatch", rawYAML, 0, params, token)
	if violation != nil || !capability.IsUsable() {
		t.Fatalf("capability mint failed: capability=%+v violation=%+v", capability, violation)
	}
	return capability
}
