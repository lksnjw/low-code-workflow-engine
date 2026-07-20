package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMCPClientDefaultModeRequiresRemoteURL(t *testing.T) {
	client := NewMCPClient("", time.Second)

	result, err := client.Execute(context.Background(), mockDemoEchoAction, map[string]interface{}{"message": "hello"})
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
	want := map[string]interface{}{
		"action": mockDemoEchoAction,
		"mock":   true,
		"echo":   map[string]interface{}{"message": "hello", "count": float64(2)},
	}

	first, err := client.Execute(context.Background(), mockDemoEchoAction, params)
	if err != nil {
		t.Fatalf("first Execute() error = %v", err)
	}
	second, err := client.Execute(context.Background(), mockDemoEchoAction, params)
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

	result, err := client.Execute(context.Background(), "send_webhook", nil)
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
	result, err := client.Execute(context.Background(), mockDemoEchoAction, params)
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
