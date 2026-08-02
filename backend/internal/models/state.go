package models

import "time"

type RunnerState struct {
	WorkflowID  string                 `json:"workflowId"`
	ExecutionID string                 `json:"executionId"`
	Variables   map[string]interface{} `json:"variables"`
	StartedAt   time.Time              `json:"startedAt"`
}

// Failure categories for an execution that stopped. These are additive: a
// governance block and a tool failure are both StatusFailed, and the status
// enum is unchanged. FailureCategory is what tells the two apart.
const (
	FailureCategoryPolicyViolation = "POLICY_VIOLATION"
	FailureCategoryToolFailure     = "TOOL_FAILURE"
	FailureCategoryValidation      = "VALIDATION_FAILURE"
	FailureCategoryInvalidRequest  = "INVALID_REQUEST"
	FailureCategoryAuthDenied      = "AUTH_DENIED"
	FailureCategoryNotFound        = "NOT_FOUND"
	FailureCategoryTransient       = "TRANSIENT"
)

// ExecutionFailure explains why an execution stopped. ToolWasCalled is the
// operationally important field: a policy violation is decided immediately
// before dispatch, so the tool was never invoked.
type ExecutionFailure struct {
	FailureCategory  string `json:"failureCategory"`
	FailedStepID     string `json:"failedStepId"`
	FailedToolName   string `json:"failedToolName"`
	RuleID           string `json:"ruleId,omitempty"`
	RuleMessage      string `json:"ruleMessage,omitempty"`
	BlockedParameter string `json:"blockedParameter,omitempty"`
	ToolWasCalled    bool   `json:"toolWasCalled"`
}

type Execution struct {
	ID           string            `json:"id"`
	WorkflowID   string            `json:"workflowId"`
	WorkflowName string            `json:"workflowName"`
	Status       string            `json:"status"`
	StartedAt    time.Time         `json:"startedAt"`
	CompletedAt  *time.Time        `json:"completedAt"`
	DurationMS   int64             `json:"durationMs"`
	Tokens       Tokens            `json:"tokens"`
	CostUSD      float64           `json:"costUsd"`
	StartedBy    Principal         `json:"startedBy"`
	Failure      *ExecutionFailure `json:"failure,omitempty"`
}

type ExecutionLog struct {
	ID          string                 `json:"id"`
	ExecutionID string                 `json:"executionId"`
	Timestamp   time.Time              `json:"timestamp"`
	Level       string                 `json:"level"`
	NodeID      string                 `json:"nodeId"`
	Message     string                 `json:"message"`
	Metadata    map[string]interface{} `json:"metadata"`
}

type ExecutionStep struct {
	ID          string            `json:"id"`
	NodeID      string            `json:"nodeId"`
	Label       string            `json:"label"`
	Status      string            `json:"status"`
	StartedAt   time.Time         `json:"startedAt"`
	CompletedAt *time.Time        `json:"completedAt"`
	DurationMS  *int64            `json:"durationMs"`
	Failure     *ExecutionFailure `json:"failure,omitempty"`
}

type HealingReport struct {
	ExecutionID string                   `json:"executionId"`
	WorkflowID  string                   `json:"workflowId"`
	Status      string                   `json:"status"`
	Summary     string                   `json:"summary"`
	Events      []map[string]interface{} `json:"events"`
	Metrics     map[string]interface{}   `json:"metrics"`
}

type RunWorkflowRequest struct {
	Input          map[string]interface{} `json:"input"`
	Mode           string                 `json:"mode"`
	DryRun         bool                   `json:"dryRun"`
	IdempotencyKey string                 `json:"idempotencyKey"`
}
