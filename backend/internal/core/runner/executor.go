package runner

import (
	"context"
	"fmt"
	"strings"
	"time"

	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

type Executor struct {
	Registry  *tools.Registry
	Validator *workflowvalidator.RegistryValidator
	Log       *zap.Logger
}

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
}

func NewExecutor(registry *tools.Registry, validator *workflowvalidator.RegistryValidator, log *zap.Logger) *Executor {
	if validator == nil {
		panic("runner requires a registry validator")
	}
	return &Executor{Registry: registry, Validator: validator, Log: log}
}

func (e *Executor) Run(ctx context.Context, executionID string, workflow models.Workflow, input map[string]interface{}, token *models.ValidationToken) (Result, error) {
	if token == nil {
		return Result{}, fmt.Errorf("validation token is required")
	}
	if !e.Validator.VerifyToken(token) {
		return Result{}, fmt.Errorf("validation token proof is invalid")
	}
	if actual := workflowvalidator.WorkflowContentHash(workflow.YAML); actual != token.WorkflowContentHash {
		return Result{}, fmt.Errorf("validation token workflow content hash mismatch")
	}
	if actual := e.Validator.RegistryHash(); actual != token.RegistryHash {
		return Result{}, fmt.Errorf("validation token registry hash mismatch")
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

		params := manager.Resolve(step.Parameters)
		if violation := e.Validator.EvaluateResolvedStep("dispatch."+executionID, blueprint, index, params, token); violation != nil {
			completed := time.Now().UTC()
			duration := completed.Sub(stepStart).Milliseconds()
			timelineStep.CompletedAt = &completed
			timelineStep.DurationMS = &duration
			timelineStep.Status = models.StatusFailed
			policyErr := &ErrDispatchPolicyViolation{
				StepIndex:     violation.StepIndex,
				ParamKey:      violation.ParamKey,
				RuleID:        violation.RuleID,
				RedactedValue: redactValue(violation.Value),
			}
			result.Timeline = append(result.Timeline, timelineStep)
			result.Logs = append(result.Logs, models.ExecutionLog{
				ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
				Level: "error", NodeID: nodeID, Message: policyErr.Error(), Metadata: map[string]interface{}{"action": step.Action, "rule_id": policyErr.RuleID, "param_key": policyErr.ParamKey},
			})
			return result, policyErr
		}
		params["_action"] = step.Action

		tool, err := e.Registry.Get(step.Action)
		if err != nil {
			return result, err
		}

		toolResult, err := tool.Execute(ctx, params)
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
			Level: "info", NodeID: nodeID, Message: fmt.Sprintf("%s executed through tool registry", step.Action), Metadata: toolResult,
		})
	}

	result.State = manager.Snapshot()
	return result, nil
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
	return step.Action
}
