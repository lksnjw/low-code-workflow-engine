package impl

import (
	"context"

	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
)

type FetchAttendanceTool struct {
	MCP *tools.MCPClient
}

func (t FetchAttendanceTool) Name() string {
	return "fetch_attendance"
}

func (t FetchAttendanceTool) Description() string {
	return "Fetches employee attendance from the ERP MCP middleware."
}

func (t FetchAttendanceTool) Execute(ctx context.Context, capability workflowvalidator.DispatchCapability, params map[string]interface{}) (map[string]interface{}, error) {
	return t.MCP.Execute(ctx, t.Name(), capability, params)
}
