package synthesizer

import (
	"strings"
	"testing"
)

func TestPromptUsesRetrievedFocusWithoutGeneratedRegistryMarkdown(t *testing.T) {
	builder := NewPromptBuilder()
	registryContext := "registry_hash: sha256:stable\n\n## 2. TOOL CATALOGUE\n\n### finance\n"
	first := builder.BuildWithRegistryContext(
		"Create an invoice",
		"balanced",
		map[string]interface{}{"tools": []string{"finance.invoice.create"}},
		registryContext,
	)
	second := builder.BuildWithRegistryContext(
		"Cancel an invoice",
		"balanced",
		map[string]interface{}{"tools": []string{"finance.invoice.cancel"}},
		registryContext,
	)
	firstPrefix := strings.Split(first, "RETRIEVED FOCUS:")[0]
	secondPrefix := strings.Split(second, "RETRIEVED FOCUS:")[0]
	if firstPrefix != secondPrefix {
		t.Fatal("static prompt prefix changed across requests")
	}
	if strings.Contains(first, registryContext) || strings.Contains(second, registryContext) {
		t.Fatal("generated registry Markdown was inserted instead of bounded retrieved focus")
	}
	if !strings.HasSuffix(strings.TrimSpace(first), "Create an invoice") ||
		!strings.HasSuffix(strings.TrimSpace(second), "Cancel an invoice") {
		t.Fatal("user request is not last in the prompt")
	}
}
