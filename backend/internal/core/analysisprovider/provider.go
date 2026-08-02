package analysisprovider

import "context"

type Response struct {
	Text         string
	Provider     string
	Model        string
	InputTokens  int
	OutputTokens int
	Measured     bool
}

type Provider interface {
	GenerateAnalysis(ctx context.Context, prompt, model string) (Response, error)
	AnalysisModel() string
}
