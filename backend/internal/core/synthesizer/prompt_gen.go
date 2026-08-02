package synthesizer

import (
	"encoding/json"
	"fmt"
)

type PromptBuilder struct{}

const workflowSchemaAndExamples = `WORKFLOW YAML CONTRACT:
- Emit YAML only. Do not emit prose or markdown fences.
- The top-level fields are exactly: name, description, trigger, steps, metadata.
- Each step may contain only: id, type, action, parameters, condition, onError, retryCount, description.
- Use only tool names listed under EXECUTABLE TOOLS or RETRIEVED FOCUS.
- Include every required parameter listed for each selected tool.

Required YAML shape:
name: string
description: string
trigger:
  type: string
  displayName: string
  config: object
steps:
  - id: string
    type: tool
    action: exact.registered.tool.name
    parameters: object
    condition: string
    onError: string
    retryCount: number
    description: string
metadata: object

STATIC EXAMPLE 1 - valid single-step shape:
name: echo_request
description: Echo a supplied message and amount.
trigger:
  type: manual
  displayName: Manual Trigger
  config: {}
steps:
  - id: echo_request
    type: tool
    action: demo.echo
    parameters:
      message: "{{input.message}}"
      amount: "{{input.amount}}"
    onError: stop
    retryCount: 1
    description: Echo the supplied values.

STATIC EXAMPLE 2 - valid step-output reference shape:
name: classify_and_notify
description: Classify an invoice and pass the result to a later notification step.
trigger:
  type: manual
  displayName: Manual Trigger
  config: {}
steps:
  - id: classify_invoice_step
    type: tool
    action: classify_invoice
    parameters:
      invoiceId: "{{input.invoice_id}}"
    onError: stop
    retryCount: 1
    description: Classify the requested invoice.
  - id: notify_finance_step
    type: tool
    action: notify_finance
    parameters:
      message: "Invoice classification: {{classify_invoice_step.classification}}"
    onError: stop
    retryCount: 1
    description: Notify finance with the classification.

The examples demonstrate schema and reference syntax only. Never copy an example action unless that exact name is present in the request's executable-tool allowlist.`

func NewPromptBuilder() PromptBuilder {
	return PromptBuilder{}
}

func (b PromptBuilder) Build(userPrompt, mode string, context map[string]interface{}) string {
	if mode == "" {
		mode = "balanced"
	}
	contextJSON, _ := json.MarshalIndent(context, "", "  ")
	return fmt.Sprintf(`SYSTEM:
You are the Agentic Workflow Engine synthesis agent.

%s

Governance:
- Never invent direct ERP database access.
- Use MCP bridge actions only.
- Follow the governance rules in RETRIEVED FOCUS.

Mode: %s

RETRIEVED FOCUS:
%s

USER REQUEST:
%s
`, workflowSchemaAndExamples, mode, string(contextJSON), redactPromptText(userPrompt))
}

func (b PromptBuilder) BuildWithRegistryContext(userPrompt, mode string, context map[string]interface{}, _ string) string {
	// Generated registry Markdown is intentionally not inserted here. Workflow
	// generation is grounded by the bounded retrieved focus supplied per request.
	return b.Build(userPrompt, mode, context)
}
