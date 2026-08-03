package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

func main() {
	cfg := config.Load()
	if strings.EqualFold(strings.TrimSpace(cfg.Environment), "production") {
		log.Fatal("mock ERP refuses to run when APP_ENV=production")
	}
	tools, err := loadRuntimeTools(cfg.ToolRegistryPath)
	if err != nil {
		log.Fatalf("load runtime tool registry: %v", err)
	}
	serviceConfig, err := loadMockERPConfig()
	if err != nil {
		log.Fatalf("load mock ERP configuration: %v", err)
	}
	service, err := newMockERPService(tools, serviceConfig, log.Default())
	if err != nil {
		log.Fatalf("initialize mock ERP fixtures: %v", err)
	}
	port := envInt("MOCK_ERP_PORT", 9000)
	address := fmt.Sprintf("127.0.0.1:%d", port)
	names := append([]string{}, service.canonicalNames...)
	sort.Strings(names)
	log.Printf("mock ERP listening address=%s tool_count=%d tools=%s", address, len(names), strings.Join(names, ","))
	if err := http.ListenAndServe(address, service); err != nil {
		log.Fatal(err)
	}
}

func loadRuntimeTools(path string) ([]coreregistry.Tool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var tools []coreregistry.Tool
	if err := json.Unmarshal(raw, &tools); err != nil {
		return nil, err
	}
	return tools, nil
}

func loadMockERPConfig() (mockERPConfig, error) {
	minimum := envInt("MOCK_ERP_MIN_LATENCY_MS", 80)
	maximum := envInt("MOCK_ERP_MAX_LATENCY_MS", 250)
	if minimum < 0 || maximum < minimum {
		return mockERPConfig{}, fmt.Errorf("MOCK_ERP latency must satisfy 0 <= min <= max")
	}
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("MOCK_ERP_FAIL_MODE")))
	switch mode {
	case "", "transient", "auth", "notfound", "invalid":
	default:
		return mockERPConfig{}, fmt.Errorf("unsupported MOCK_ERP_FAIL_MODE %q", mode)
	}
	return mockERPConfig{
		MinLatency: time.Duration(minimum) * time.Millisecond,
		MaxLatency: time.Duration(maximum) * time.Millisecond,
		FailTool:   strings.TrimSpace(os.Getenv("MOCK_ERP_FAIL_TOOL")),
		FailMode:   mode,
	}, nil
}

func envInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}
