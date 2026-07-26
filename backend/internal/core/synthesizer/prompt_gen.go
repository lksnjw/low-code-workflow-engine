package synthesizer

import (
	"encoding/json"
	"fmt"
)

type PromptBuilder struct{}

func NewPromptBuilder() PromptBuilder {
	return PromptBuilder{}
}

func (b PromptBuilder) Build(userPrompt, mode string, context map[string]interface{}) string {
	return b.BuildWithRegistryContext(userPrompt, mode, context, "")
}

func (b PromptBuilder) BuildWithRegistryContext(userPrompt, mode string, context map[string]interface{}, registryContext string) string {
	if mode == "" {
		mode = "balanced"
	}

	contextJSON, _ := json.MarshalIndent(context, "", "  ")
	return fmt.Sprintf(`You are the Agentic Workflow Engine synthesis agent.

Return ONLY valid YAML. Do not use markdown fences. Do not explain.

- Do not invent action names. Use only actions explicitly supplied in Context.
- If Context has no executable tools, return a workflow with an empty steps list.

Required YAML schema:
name: string
description: string
trigger:
  type: string
  displayName: string
  config: object
steps:
  - id: string
    action: string
    parameters: object
    retryCount: number
    onError: string

Governance:
- Never invent direct ERP database access.
- Use MCP bridge actions only.
- Include policy_check before production writes.
- Include retryCount on external connector calls.

Mode: %s

REGISTRY GENERATION CONTEXT:
%s

RETRIEVED FOCUS:
%s

USER REQUEST:
%s
`, mode, registryContext, string(contextJSON), userPrompt)
}
