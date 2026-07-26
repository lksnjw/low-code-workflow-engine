package synthesizer

import (
	"strings"
	"testing"
)

func TestPromptPrefixIsStableAcrossRequests(t *testing.T) {
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
		t.Fatal("system instructions and registry Markdown prefix changed across requests")
	}
	if !strings.HasSuffix(strings.TrimSpace(first), "Create an invoice") ||
		!strings.HasSuffix(strings.TrimSpace(second), "Cancel an invoice") {
		t.Fatal("user request is not last in the prompt")
	}
}
