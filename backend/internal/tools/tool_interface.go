package tools

import (
	"context"

	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
)

type Tool interface {
	Name() string
	Description() string
	Execute(ctx context.Context, capability workflowvalidator.DispatchCapability, params map[string]interface{}) (map[string]interface{}, error)
}

type ToolResult struct {
	Action string                 `json:"action"`
	Result map[string]interface{} `json:"result"`
}
