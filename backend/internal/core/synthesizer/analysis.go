package synthesizer

import (
	"context"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/analysisprovider"
)

// GenerateAnalysis uses the same active-provider resolution and clients as
// workflow synthesis; it does not create a second provider path.
func (s *Service) GenerateAnalysis(ctx context.Context, prompt, model string) (analysisprovider.Response, error) {
	text, provider, selected, usage, err := s.generateWithUsage(ctx, prompt, model)
	if err != nil {
		return analysisprovider.Response{}, err
	}
	return analysisprovider.Response{
		Text:         text,
		Provider:     provider,
		Model:        selected,
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		Measured:     usage.Measured,
	}, nil
}

// AnalysisModel returns the model selected by the active provider factory.
// It is used in the execution-local cache key.
func (s *Service) AnalysisModel() string {
	if config, ok := s.activeProvider(); ok {
		return strings.TrimSpace(config.Model)
	}
	if strings.EqualFold(s.Provider, "gemini") && s.Gemini != nil {
		return strings.TrimSpace(s.Gemini.Model)
	}
	if strings.EqualFold(s.Provider, "ollama") && s.Ollama != nil {
		return strings.TrimSpace(s.Ollama.Model)
	}
	return ""
}
