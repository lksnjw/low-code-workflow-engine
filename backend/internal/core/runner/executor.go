package runner

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/analysisprovider"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/redact"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

// ErrDispatchPolicyViolation is returned before a tool call when a resolved
// value violates a deferred or sensitive-data policy. It never retains the
// unredacted offending value.
type ErrDispatchPolicyViolation struct {
	StepIndex     int
	ParamKey      string
	RuleID        string
	RedactedValue string
}

func (e *ErrDispatchPolicyViolation) Error() string {
	return fmt.Sprintf("dispatch policy violation at step %d parameter %s rule %s (value %s)", e.StepIndex, e.ParamKey, e.RuleID, e.RedactedValue)
}

type Result struct {
	Logs     []models.ExecutionLog  `json:"logs"`
	Timeline []models.ExecutionStep `json:"timeline"`
	State    map[string]interface{} `json:"state"`
	Tokens   models.Tokens          `json:"tokens"`
}

func NewExecutor(registry *tools.Registry, validator *workflowvalidator.RegistryValidator, log *zap.Logger) *Executor {
	if validator == nil {
		panic("runner requires a registry validator")
	}
	return &Executor{Registry: registry, Validator: validator, Log: log}
}

func (e *Executor) SetAnalysisProvider(provider analysisprovider.Provider) {
	e.AnalysisProvider = provider
}

func (e *Executor) Run(ctx context.Context, executionID string, workflow models.Workflow, input map[string]interface{}, token *models.ValidationToken) (Result, error) {
	contentHash := workflowvalidator.WorkflowContentHash(workflow.YAML)
	if decision, reason, evidence := e.validationTokenBlock(contentHash, token); reason != "" {
		if blockErr := e.handleValidationTokenBlock(executionID, contentHash, decision, reason, evidence); blockErr != nil {
			return Result{}, blockErr
		}
	}
	blueprint, err := workflowvalidator.ParseWorkflowYAMLStrict(workflow.YAML)
	if err != nil {
		return Result{}, fmt.Errorf("validated workflow content cannot be decoded: %w", err)
	}

	started := time.Now().UTC()
	manager := NewStateManager(models.RunnerState{
		WorkflowID:  workflow.ID,
		ExecutionID: executionID,
		Variables: map[string]interface{}{
			"input": input,
		},
		StartedAt: started,
	})

	result := Result{
		Logs:     []models.ExecutionLog{},
		Timeline: []models.ExecutionStep{},
		State:    manager.Snapshot(),
	}
	analysisCache := map[string]analysisCacheEntry{}

	for index, step := range blueprint.Steps {
		stepStart := time.Now().UTC()
		nodeID := step.ID
		timelineStep := models.ExecutionStep{
			ID:        fmt.Sprintf("step_%03d", index+1),
			NodeID:    nodeID,
			Label:     labelForStep(step),
			Status:    models.StatusRunning,
			StartedAt: stepStart,
		}
		if step.EffectiveKind() == models.StepKindAnalysis {
			sideEffect := false
			timelineStep.SideEffect = &sideEffect
			outcome, analysisErr := e.executeAnalysisStep(ctx, executionID, blueprint, index, manager, token, analysisCache)
			completed := time.Now().UTC()
			duration := completed.Sub(stepStart).Milliseconds()
			timelineStep.CompletedAt = &completed
			timelineStep.DurationMS = &duration
			if analysisErr != nil {
				timelineStep.Status = models.StatusFailed
				result.Timeline = append(result.Timeline, timelineStep)
				result.Logs = append(result.Logs, models.ExecutionLog{
					ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
					Level: "error", NodeID: nodeID, Message: analysisErr.Error(), Metadata: map[string]interface{}{"kind": models.StepKindAnalysis, "sideEffect": false},
				})
				return result, analysisErr
			}
			manager.Save(step.ID, map[string]interface{}{"output": outcome.output})
			result.Tokens.Input += outcome.inputTokens
			result.Tokens.Output += outcome.outputTokens
			result.Tokens.Total = result.Tokens.Input + result.Tokens.Output
			timelineStep.Status = models.StatusDone
			result.Timeline = append(result.Timeline, timelineStep)
			result.Logs = append(result.Logs, models.ExecutionLog{
				ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
				Level: "info", NodeID: nodeID, Message: "analysis completed with structured output", Metadata: map[string]interface{}{"kind": models.StepKindAnalysis, "sideEffect": false, "cached": outcome.cached, "inputTokens": outcome.inputTokens, "outputTokens": outcome.outputTokens},
			})
			continue
		}

		params := manager.Resolve(step.Parameters)
		params["_action"] = step.Action
		capability, violation := e.Validator.EvaluateResolvedStep("dispatch."+executionID, workflow.YAML, index, params, token)
		if violation != nil {
			policyErr := e.handleDispatchViolation(executionID, contentHash, violation)
			if policyErr == nil {
				goto dispatch
			}
			completed := time.Now().UTC()
			duration := completed.Sub(stepStart).Milliseconds()
			timelineStep.CompletedAt = &completed
			timelineStep.DurationMS = &duration
			timelineStep.Status = models.StatusFailed
			result.Timeline = append(result.Timeline, timelineStep)
			result.Logs = append(result.Logs, models.ExecutionLog{
				ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
				Level: "error", NodeID: nodeID, Message: policyErr.Error(), Metadata: map[string]interface{}{"action": step.Action, "rule_id": policyErr.RuleID, "param_key": policyErr.ParamKey},
			})
			return result, policyErr
		}
	dispatch:
		tool, err := e.Registry.Get(step.Action)
		if err != nil {
			return result, err
		}

		toolResult, err := tool.Execute(ctx, capability, params)
		completed := time.Now().UTC()
		duration := completed.Sub(stepStart).Milliseconds()
		timelineStep.CompletedAt = &completed
		timelineStep.DurationMS = &duration

		if err != nil {
			timelineStep.Status = models.StatusFailed
			result.Timeline = append(result.Timeline, timelineStep)
			result.Logs = append(result.Logs, models.ExecutionLog{
				ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
				Level: "error", NodeID: nodeID, Message: err.Error(), Metadata: map[string]interface{}{"action": step.Action},
			})
			return result, fmt.Errorf("step %s failed: %w", step.ID, err)
		}

		manager.Save(step.ID, toolResult)
		timelineStep.Status = models.StatusDone
		result.Timeline = append(result.Timeline, timelineStep)
		result.Logs = append(result.Logs, models.ExecutionLog{
			ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
			Level: "info", NodeID: nodeID, Message: fmt.Sprintf("%s executed through tool registry", step.Action), Metadata: redact.WithoutSecretFields(toolResult),
		})
	}

	result.State = manager.Snapshot()
	return result, nil
}

func (e *Executor) validationTokenBlock(contentHash string, token *models.ValidationToken) (string, string, map[string]interface{}) {
	if token == nil {
		return "validation_token_required", "validation token is required", nil
	}
	if !e.Validator.VerifyToken(token) {
		return "validation_token_proof", "validation token proof is invalid", nil
	}
	if contentHash != token.WorkflowContentHash {
		return "workflow_content_hash", "validation token workflow content hash mismatch", map[string]interface{}{
			"token_workflow_content_hash": token.WorkflowContentHash,
		}
	}
	if actual := e.Validator.RegistryHash(); actual != token.RegistryHash {
		return "registry_hash", "validation token registry hash mismatch", map[string]interface{}{
			"token_registry_hash": token.RegistryHash,
		}
	}
	return "", "", nil
}

func redactValue(value interface{}) string {
	text := fmt.Sprint(value)
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= 4 {
		return string(runes)
	}
	return string(runes[:4]) + "…"
}

func labelForStep(step models.WorkflowStepBlueprint) string {
	if step.Description != "" {
		return step.Description
	}
	if step.Type != "" {
		return step.Type + ": " + step.Action
	}
	if step.EffectiveKind() == models.StepKindAnalysis {
		return "analysis: " + step.ID
	}
	return step.Action
}
