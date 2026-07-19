package unit

import (
	"context"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
)

func TestSynthesizerReturnsProviderErrorWhenDisabled(t *testing.T) {
	service := synthesizer.NewService("http://localhost:11434", "phi3:mini", false)
	_, err := service.Synthesize(context.Background(), "approve employee leave", "balanced", "", nil)
	if err == nil {
		t.Fatal("expected synthesis to fail when the configured provider is unavailable")
	}
}
