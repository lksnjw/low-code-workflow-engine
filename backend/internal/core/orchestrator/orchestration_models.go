package orchestrator

import (
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
)

type ChatRequest struct {
	SessionID     string
	UserText      string
	UserRole      string
	Mode          string
	Model         string
	TopKTools     int
	TopKRules     int
	TopKTemplates int
	TopKExamples  int
	GenerateCount int
}

type CandidateReport struct {
	CandidateID string                                      `json:"candidate_id"`
	YAML        string                                      `json:"yaml"`
	Generation  map[string]interface{}                      `json:"generation_metadata"`
	Validation  workflowvalidator.CandidateValidationResult `json:"validation"`
}

type ValidationSummary struct {
	PassedCandidates  int     `json:"passed_candidates"`
	BlockedCandidates int     `json:"blocked_candidates"`
	BestScore         float64 `json:"best_score"`
}

type ChatResponse struct {
	SessionID            string                          `json:"session_id"`
	AssistantMessage     string                          `json:"assistant_message"`
	Retrieval            semanticsearch.Result           `json:"retrieval"`
	Candidates           []CandidateReport               `json:"candidates"`
	SelectedCandidateID  string                          `json:"selected_candidate_id"`
	SelectedWorkflowYAML string                          `json:"selected_workflow_yaml"`
	CanExecute           bool                            `json:"can_execute"`
	ValidationSummary    ValidationSummary               `json:"validation_summary"`
	BlockingErrors       []string                        `json:"blocking_errors,omitempty"`
	NextAction           string                          `json:"next_action,omitempty"`
	RawCandidates        []synthesizer.WorkflowCandidate `json:"-"`
}
