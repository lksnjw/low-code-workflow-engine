package config

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMockErpBackendMarkerIsDetected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/healthz" {
			t.Fatalf("path = %s, want /healthz", request.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"service":"mock-erp","status":"healthy","toolCount":22}`))
	}))
	defer server.Close()

	info, err := InspectMCPBackend(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("InspectMCPBackend() error = %v", err)
	}
	if info.Kind != MCPBackendMockERP || info.ToolCount != 22 {
		t.Fatalf("InspectMCPBackend() = %+v", info)
	}
}
