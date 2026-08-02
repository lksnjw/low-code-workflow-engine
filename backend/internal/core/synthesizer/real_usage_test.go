package synthesizer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	generationcontext "github.com/sanjeewa/agentic-orchestrator/internal/core/context"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"go.uber.org/zap"
)

func TestRealProviderRegistryMarkdownDoesNotChangePromptTokens(t *testing.T) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY is not set; real provider telemetry test is opt-in")
	}
	toolPath := filepath.Join("..", "..", "..", "configs", "runtime", "all_tools_master_registry.json")
	rulePath := filepath.Join("..", "..", "..", "configs", "runtime", "all_rules_master_registry.json")
	bundle, err := registry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := registry.NewManager(bundle, toolPath, rulePath)
	contextService := generationcontext.NewService(manager, zap.NewNop())
	if _, err := contextService.Regenerate(); err != nil {
		t.Fatal(err)
	}
	service := NewServiceWithProvider("", "", false, "gemini", apiKey, "gemini-2.5-flash")

	baseline, err := service.Synthesize(context.Background(), "Return a minimal manual workflow with no steps.", "balanced", "", map[string]interface{}{"domain": "finance"})
	if err != nil {
		t.Fatal(err)
	}
	service.SetRegistryContext(contextService)
	withContext, err := service.Synthesize(context.Background(), "Return a minimal manual workflow with no steps.", "balanced", "", map[string]interface{}{"domain": "finance"})
	if err != nil {
		t.Fatal(err)
	}
	if baseline.Usage["measured"] != true || withContext.Usage["measured"] != true {
		t.Fatal("provider did not report measured token usage")
	}
	if baseline.Usage["inputTokens"] != withContext.Usage["inputTokens"] {
		t.Fatalf("registry Markdown changed prompt tokens: without=%v with=%v", baseline.Usage["inputTokens"], withContext.Usage["inputTokens"])
	}
	t.Logf("REAL_USAGE without_registry_markdown_tokens=%v configured_context_tokens=%v delta=%d without_measured=%v configured_measured=%v",
		baseline.Usage["inputTokens"],
		withContext.Usage["inputTokens"],
		withContext.Usage["inputTokens"].(int)-baseline.Usage["inputTokens"].(int),
		baseline.Usage["measured"],
		withContext.Usage["measured"],
	)
}
