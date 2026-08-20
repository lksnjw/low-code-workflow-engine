package synthesizer

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

const (
	candidatePromptTemplateVersion = "prompt/candidate/v1"
	maxPromptTools            = 10
	maxPromptRules            = 15
	maxPromptGlobalRules      = 8
	maxPromptTemplates        = 5
	maxPromptExamples         = 3
	maxPromptDescriptionRunes = 600
	maxPromptInstructionRunes = 600
	maxRepairErrors           = 12
	maxRepairErrorRunes       = 500
	maxRejectedYAMLRunes      = 8000
)

type CandidateRepairFeedback struct {
	RejectedYAML     string
	ValidationErrors []string
}

type CandidateGenerationRequest struct {
	Prompt             string
	UserRole           string
	Mode               string
	Model              string
	CandidateCount     int
	Tools              []registry.Tool
	MissingSchemaTools []registry.Tool
	FutureCapabilities []registry.Tool
	Rules              []registry.Rule
	GlobalRules        []registry.Rule
	Templates          []registry.ProcessTemplate
	Examples           []registry.FewShotExample
	RegistryContext    string
	Repair             *CandidateRepairFeedback
}

type WorkflowCandidate struct {
	CandidateID        string                 `json:"candidate_id"`
	RawYAML            string                 `json:"yaml"`
	ModelName          string                 `json:"model_name"`
	GenerationMetadata map[string]interface{} `json:"generation_metadata"`
	ParseError         string                 `json:"parse_error,omitempty"`
}

func (s *Service) GenerateCandidates(ctx context.Context, req CandidateGenerationRequest) ([]WorkflowCandidate, error) {
	if req.CandidateCount <= 0 {
		req.CandidateCount = 5
	}
	if req.CandidateCount > 5 {
		req.CandidateCount = 5
	}
	if req.Repair != nil {
		req.CandidateCount = 1
	}
	req = boundCandidateRequest(req)
	prompt := s.Prompt.BuildCandidatePrompt(req)
	promptDigest := sha256.Sum256([]byte(prompt))
	promptSHA256 := "sha256:" + hex.EncodeToString(promptDigest[:])
	raw, provider, model, usage, err := s.generateWithUsage(ctx, prompt, req.Model)
	if err != nil {
		return nil, err
	}
	toolCount, ruleCount := promptContextCounts(req)
	s.logPromptUsage("workflow_candidate_generation", provider, model, usage, len(prompt), toolCount, ruleCount)
	candidates := ParseCandidateResponse(raw, model, false)
	if len(candidates) == 0 {
		return nil, fmt.Errorf("gemini returned no parseable YAML candidates")
	}
	candidates = limitCandidates(candidates, req.CandidateCount)
	for index := range candidates {
		if candidates[index].GenerationMetadata == nil {
			candidates[index].GenerationMetadata = map[string]interface{}{}
		}
		candidates[index].GenerationMetadata["inputTokens"] = usage.InputTokens
		candidates[index].GenerationMetadata["outputTokens"] = usage.OutputTokens
		candidates[index].GenerationMetadata["costUsd"] = 0.0
		candidates[index].GenerationMetadata["measured"] = usage.Measured
		candidates[index].GenerationMetadata["temperature"] = usage.Temperature
		candidates[index].GenerationMetadata["provider"] = provider
		candidates[index].GenerationMetadata["model"] = model
		candidates[index].GenerationMetadata["promptToolCount"] = toolCount
		candidates[index].GenerationMetadata["promptRuleCount"] = ruleCount
		candidates[index].GenerationMetadata["promptTemplateVersion"] = candidatePromptTemplateVersion
		candidates[index].GenerationMetadata["promptSha256"] = promptSHA256
		candidates[index].GenerationMetadata["generationAttempt"] = generationAttempt(req)
	}
	return candidates, nil
}

func (b PromptBuilder) BuildCandidatePrompt(req CandidateGenerationRequest) string {
	if req.Mode == "" {
		req.Mode = "generate_workflow"
	}

	executableTools, missingSchemaTools, futureCapabilities := splitPromptTools(req)
	executableSummaries := make([]map[string]interface{}, 0, len(executableTools))
	for _, tool := range executableTools {
		executableSummaries = append(executableSummaries, promptToolSummary(tool))
	}
	missingSchemaSummaries := make([]map[string]interface{}, 0, len(missingSchemaTools))
	for _, tool := range missingSchemaTools {
		missingSchemaSummaries = append(missingSchemaSummaries, promptToolSummary(tool))
	}
	futureSummaries := make([]map[string]interface{}, 0, len(futureCapabilities))
	for _, tool := range futureCapabilities {
		futureSummaries = append(futureSummaries, promptToolSummary(tool))
	}

	ruleSummaries := make([]map[string]interface{}, 0, len(req.Rules)+len(req.GlobalRules))
	for _, rule := range append(req.Rules, req.GlobalRules...) {
		ruleSummaries = append(ruleSummaries, promptRuleSummary(rule))
	}
	templateSummaries := make([]map[string]interface{}, 0, len(req.Templates))
	for _, template := range req.Templates {
		templateSummaries = append(templateSummaries, promptTemplateSummary(template))
	}

	executableJSON, _ := json.MarshalIndent(executableSummaries, "", "  ")
	missingSchemaJSON, _ := json.MarshalIndent(missingSchemaSummaries, "", "  ")
	futureJSON, _ := json.MarshalIndent(futureSummaries, "", "  ")
	rulesJSON, _ := json.MarshalIndent(ruleSummaries, "", "  ")
	templateJSON, _ := json.MarshalIndent(templateSummaries, "", "  ")
	examples := buildFewShotExamples(req.Examples, executableTools, maxPromptExamples)
	repairSection := buildRepairSection(req.Repair)

	return fmt.Sprintf(`SYSTEM:
You are an enterprise YAML workflow blueprint generator for a legacy ERP orchestration system.

RESPONSIBILITY:
Generate workflow candidates only.
Do not execute workflows.
Do not validate workflows.
Do not decide safety.
The Go backend validator is the only authority for validation and execution eligibility.

STRICT RULES:
- Only tools listed under EXECUTABLE TOOLS may appear in steps.action.
- use only these tool names; do not invent tools; include every required parameter.
- Tools listed under MISSING SCHEMA TOOLS must not appear in steps.action.
- Tools listed under FUTURE CAPABILITIES must not appear in steps.action.
- Do not invent actions, tool names, parameters, approvals, or audit tools.
- Include all required parameters for every selected tool.
- Follow RELEVANT GOVERNANCE RULES.
- Never generate workflows for deleting, removing, disabling, terminating, or revoking admins, users, employees, roles, permissions, access, or accounts.
- If using procurement.create_purchase_order, include procurement.validate_vendor first, before any procurement.create_purchase_order step.
- For purchase order requests, use this process order when the tools exist: procurement.validate_vendor, policy.check_policy_limit, approval.request_human_approval when required, procurement.create_purchase_order, audit.write_audit_log.
- High-risk workflows should include approval and audit steps only when executable tools exist for those actions and rules require them.
- Return exactly %d candidates.
- Return candidate blocks only. Do not use markdown fences. Do not add prose outside candidate blocks.
- Do not include API keys, tokens, passwords, auth headers, private keys, or secrets.
- If a required parameter is unknown, use a safe placeholder like "{{input.vendor_id}}" instead of inventing confidential data.
- If EXECUTABLE TOOLS is empty, generate a capability-request workflow only when capability.create_capability_request is in EXECUTABLE TOOLS; otherwise generate no executable business workflow.

%s

RETURN FORMAT:
--- candidate_1 ---
name: ...
description: ...
trigger:
  type: manual
  displayName: Manual Trigger
  config: {}
steps:
  - id: step_1
    type: tool
    action: exact.registered.tool
    description: ...
    parameters: {}
    condition: ""
    retryCount: 1
    onError: stop

--- candidate_2 ---
...

RETRIEVED FOCUS:

EXECUTABLE TOOLS:
Only these tools may be used in steps.action.
%s

MISSING SCHEMA TOOLS:
These tools have mock endpoints but no executable MCP schema. They are context only and must not be used in steps.action.
%s

FUTURE CAPABILITIES:
These tools are planned/research capabilities. They are context only and must not be used in steps.action.
%s

RELEVANT GOVERNANCE RULES:
%s

RELEVANT PROCESS TEMPLATES:
%s

FEW-SHOT EXAMPLES:
%s

%s

USER ROLE:
%s

USER REQUEST:
%s
`, req.CandidateCount, workflowSchemaAndExamples, string(executableJSON), string(missingSchemaJSON), string(futureJSON), string(rulesJSON), string(templateJSON), examples, repairSection, req.UserRole, redactPromptText(req.Prompt))
}

func toolDomains(tools []registry.Tool) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, tool := range tools {
		domain := strings.TrimSpace(tool.Module)
		key := strings.ToLower(domain)
		if domain == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, domain)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i]) < strings.ToLower(out[j]) })
	return out
}

func ParseCandidateResponse(raw, model string, fallback bool) []WorkflowCandidate {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}

	var wrapper struct {
		Candidates []struct {
			CandidateID string `json:"candidate_id"`
			YAML        string `json:"yaml"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal([]byte(raw), &wrapper); err == nil && len(wrapper.Candidates) > 0 {
		out := make([]WorkflowCandidate, 0, len(wrapper.Candidates))
		for index, item := range wrapper.Candidates {
			id := item.CandidateID
			if id == "" {
				id = fmt.Sprintf("candidate_%d", index+1)
			}
			out = append(out, WorkflowCandidate{
				CandidateID: id,
				RawYAML:     strings.TrimSpace(item.YAML),
				ModelName:   model,
				GenerationMetadata: map[string]interface{}{
					"fallback": fallback,
					"format":   "json",
				},
			})
		}
		return out
	}

	separator := regexp.MustCompile(`(?m)^---\s*(candidate[_ -]?\d+)\s*---\s*$`)
	indexes := separator.FindAllStringSubmatchIndex(raw, -1)
	if len(indexes) > 0 {
		out := []WorkflowCandidate{}
		for i, idx := range indexes {
			id := raw[idx[2]:idx[3]]
			start := idx[1]
			end := len(raw)
			if i+1 < len(indexes) {
				end = indexes[i+1][0]
			}
			out = append(out, WorkflowCandidate{
				CandidateID: strings.ReplaceAll(id, " ", "_"),
				RawYAML:     strings.TrimSpace(raw[start:end]),
				ModelName:   model,
				GenerationMetadata: map[string]interface{}{
					"fallback": fallback,
					"format":   "separator",
				},
			})
		}
		return out
	}

	return []WorkflowCandidate{{
		CandidateID: "candidate_1",
		RawYAML:     raw,
		ModelName:   model,
		GenerationMetadata: map[string]interface{}{
			"fallback": fallback,
			"format":   "single_yaml",
		},
	}}
}

func parseCandidateResponse(raw, model string, fallback bool) []WorkflowCandidate {
	return ParseCandidateResponse(raw, model, fallback)
}

func limitTemplates(templates []registry.ProcessTemplate, max int) []registry.ProcessTemplate {
	if len(templates) <= max {
		return templates
	}
	return templates[:max]
}

func boundCandidateRequest(req CandidateGenerationRequest) CandidateGenerationRequest {
	remainingTools := maxPromptTools
	req.Tools = limitTools(uniqueTools(req.Tools), remainingTools)
	remainingTools -= len(req.Tools)
	req.MissingSchemaTools = limitTools(uniqueTools(req.MissingSchemaTools), remainingTools)
	remainingTools -= len(req.MissingSchemaTools)
	req.FutureCapabilities = limitTools(uniqueTools(req.FutureCapabilities), remainingTools)
	req.GlobalRules = limitRules(uniqueRules(req.GlobalRules), maxPromptGlobalRules)
	req.Rules = limitRules(uniqueRules(req.Rules), maxPromptRules-len(req.GlobalRules))
	req.Templates = limitTemplates(req.Templates, maxPromptTemplates)
	if len(req.Examples) > maxPromptExamples {
		req.Examples = req.Examples[:maxPromptExamples]
	}
	// The generated Markdown contains the full registry when no domain is
	// selected. Candidate generation uses only the bounded retrieved objects.
	req.RegistryContext = ""
	if req.Repair != nil {
		repair := &CandidateRepairFeedback{
			RejectedYAML: truncateRunes(redactPromptText(req.Repair.RejectedYAML), maxRejectedYAMLRunes),
		}
		seen := map[string]bool{}
		for _, item := range req.Repair.ValidationErrors {
			item = truncateRunes(redactPromptText(strings.TrimSpace(item)), maxRepairErrorRunes)
			if item == "" || seen[item] {
				continue
			}
			seen[item] = true
			repair.ValidationErrors = append(repair.ValidationErrors, item)
			if len(repair.ValidationErrors) == maxRepairErrors {
				break
			}
		}
		req.Repair = repair
	}
	return req
}

func promptContextCounts(req CandidateGenerationRequest) (int, int) {
	executable, missing, future := splitPromptTools(req)
	return len(executable) + len(missing) + len(future), len(req.Rules) + len(req.GlobalRules)
}

func generationAttempt(req CandidateGenerationRequest) string {
	if req.Repair != nil {
		return "repair"
	}
	return "initial"
}

func buildRepairSection(repair *CandidateRepairFeedback) string {
	if repair == nil {
		return "GENERATION ATTEMPT:\nInitial generation."
	}
	var b strings.Builder
	b.WriteString("GENERATION ATTEMPT:\nThis is the single bounded repair attempt. Correct the rejected candidate using every specific validator error below. Do not repeat an invalid field or tool.\n\nREJECTED CANDIDATE YAML:\n")
	b.WriteString(repair.RejectedYAML)
	b.WriteString("\n\nVALIDATOR ERRORS:\n")
	if len(repair.ValidationErrors) == 0 {
		b.WriteString("- The candidate did not pass the full registry gate.\n")
	} else {
		for _, item := range repair.ValidationErrors {
			fmt.Fprintf(&b, "- %s\n", item)
		}
	}
	b.WriteString("\nReturn exactly one corrected candidate and no explanation.")
	return b.String()
}

func limitTools(items []registry.Tool, max int) []registry.Tool {
	if max <= 0 {
		return nil
	}
	if len(items) <= max {
		return items
	}
	return items[:max]
}

func uniqueRules(items []registry.Rule) []registry.Rule {
	seen := map[string]bool{}
	out := make([]registry.Rule, 0, len(items))
	for _, item := range items {
		key := strings.ToLower(strings.TrimSpace(item.RuleID))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, item)
	}
	return out
}

func limitRules(items []registry.Rule, max int) []registry.Rule {
	if max <= 0 {
		return nil
	}
	if len(items) <= max {
		return items
	}
	return items[:max]
}

func limitStrings(items []string, max int) []string {
	if max <= 0 {
		return nil
	}
	if len(items) <= max {
		return append([]string(nil), items...)
	}
	return append([]string(nil), items[:max]...)
}

func truncateRunes(value string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

func promptToolSummary(tool registry.Tool) map[string]interface{} {
	return map[string]interface{}{
		"name":                tool.Name,
		"description":         truncateRunes(tool.Description, maxPromptDescriptionRunes),
		"required_parameters": append([]string(nil), tool.RequiredParameters...),
		"optional_parameters": limitStrings(tool.OptionalParameters, 20),
		"allowed_roles":       limitStrings(tool.AllowedRoles, 20),
		"risk_level":          tool.RiskLevel,
		"status":              tool.Status,
		"current_gaps":        limitStrings(tool.CurrentGaps, 10),
	}
}

func promptRuleSummary(rule registry.Rule) map[string]interface{} {
	return map[string]interface{}{
		"rule_id":                rule.RuleID,
		"rule_name":              truncateRunes(rule.RuleName, maxPromptDescriptionRunes),
		"description":            truncateRunes(rule.Description, maxPromptDescriptionRunes),
		"applies_to_tools":       limitStrings(rule.AppliesToTools, maxPromptTools),
		"enforcement_action":     rule.EnforcementAction,
		"severity":               rule.Severity,
		"llm_prompt_instruction": truncateRunes(rule.LLMPromptInstruction, maxPromptInstructionRunes),
	}
}

func promptTemplateSummary(template registry.ProcessTemplate) map[string]interface{} {
	return map[string]interface{}{
		"template_id":      template.TemplateID,
		"template_name":    truncateRunes(template.TemplateName, maxPromptDescriptionRunes),
		"description":      truncateRunes(template.Description, maxPromptDescriptionRunes),
		"required_tools":   limitStrings(template.RequiredTools, maxPromptTools),
		"required_rules":   limitStrings(template.RequiredRules, maxPromptRules),
		"validation_focus": limitStrings(template.ValidationFocus, 10),
	}
}

func splitPromptTools(req CandidateGenerationRequest) ([]registry.Tool, []registry.Tool, []registry.Tool) {
	if len(req.MissingSchemaTools) > 0 || len(req.FutureCapabilities) > 0 {
		return uniqueTools(req.Tools), uniqueTools(req.MissingSchemaTools), uniqueTools(req.FutureCapabilities)
	}

	executable := []registry.Tool{}
	missingSchema := []registry.Tool{}
	future := []registry.Tool{}
	for _, tool := range req.Tools {
		switch strings.ToLower(strings.TrimSpace(tool.Status)) {
		case "", "active_mcp_schema_present":
			executable = append(executable, tool)
		case "mock_endpoint_available_schema_missing":
			missingSchema = append(missingSchema, tool)
		case "recommended_future_capability":
			future = append(future, tool)
		default:
			future = append(future, tool)
		}
	}
	return uniqueTools(executable), uniqueTools(missingSchema), uniqueTools(future)
}

func uniqueTools(tools []registry.Tool) []registry.Tool {
	seen := map[string]bool{}
	out := []registry.Tool{}
	for _, tool := range tools {
		key := strings.ToLower(firstNonEmpty(tool.ToolID, tool.Name, tool.MCPToolName))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, tool)
	}
	return out
}

func buildFewShotExamples(examples []registry.FewShotExample, tools []registry.Tool, max int) string {
	if len(examples) == 0 {
		return "No matching few-shot examples were retrieved."
	}
	toolLookup := map[string]registry.Tool{}
	for _, tool := range tools {
		toolLookup[strings.ToLower(tool.Name)] = tool
		toolLookup[strings.ToLower(tool.ToolID)] = tool
	}
	selected := selectFewShotExamples(examples, toolLookup, max)
	if len(selected) == 0 {
		return "No executable few-shot examples matched the retrieved executable tools."
	}
	var b strings.Builder
	for index, example := range selected {
		fmt.Fprintf(&b, "Example %d - Valid executable workflow:\n", index+1)
		fmt.Fprintf(&b, "User request:\n%s\n\n", truncateRunes(redactPromptText(example.UserRequest), maxPromptDescriptionRunes))
		fmt.Fprintf(&b, "User role:\n%s\n\n", firstNonEmpty(example.UserRole, "authenticated_user"))
		fmt.Fprintf(&b, "Available executable tools:\n")
		for _, tool := range limitStrings(example.ExpectedTools, maxPromptTools) {
			fmt.Fprintf(&b, "- %s\n", tool)
		}
		fmt.Fprintf(&b, "\nRelevant rules:\n")
		for _, rule := range limitStrings(example.ExpectedRules, maxPromptRules) {
			fmt.Fprintf(&b, "- %s\n", rule)
		}
		fmt.Fprintf(&b, "\nExpected YAML shape:\n")
		fmt.Fprintf(&b, "name: example_%s\n", safeID(firstNonEmpty(example.ExpectedIntent, example.ExpectedDomain, "workflow")))
		fmt.Fprintf(&b, "description: %s\n", yamlScalar("Example workflow following retrieved tools and rules."))
		fmt.Fprintf(&b, "trigger:\n  type: manual\n  displayName: Manual Trigger\n  config: {}\nsteps:\n")
		for stepIndex, toolName := range example.ExpectedTools {
			tool := toolLookup[strings.ToLower(toolName)]
			fmt.Fprintf(&b, "  - id: step_%d\n", stepIndex+1)
			fmt.Fprintf(&b, "    type: tool\n")
			fmt.Fprintf(&b, "    action: %s\n", toolName)
			fmt.Fprintf(&b, "    description: %q\n", "Execute "+toolName)
			fmt.Fprintf(&b, "    parameters:")
			if len(tool.RequiredParameters) == 0 {
				fmt.Fprintf(&b, " {}\n")
			} else {
				fmt.Fprintf(&b, "\n")
				for _, param := range tool.RequiredParameters {
					fmt.Fprintf(&b, "      %s: %s\n", param, yamlScalar(exampleValueForParam(example.UserRequest, param)))
				}
			}
			fmt.Fprintf(&b, "    condition: \"\"\n    retryCount: 1\n    onError: stop\n")
		}
		fmt.Fprintf(&b, "\nWhy it is valid:\nAll steps use executable tools from the provided allowlist, required parameters are present, and relevant rules are represented without inventing unavailable capabilities.\n\n")
	}
	return b.String()
}

func selectFewShotExamples(examples []registry.FewShotExample, toolLookup map[string]registry.Tool, max int) []registry.FewShotExample {
	selected := []registry.FewShotExample{}
	for _, example := range examples {
		decision := strings.ToLower(strings.TrimSpace(example.ExpectedDecision))
		if decision != "" && decision != "generate_workflow" {
			continue
		}
		if len(example.ExpectedTools) == 0 {
			continue
		}
		allExecutable := true
		for _, toolName := range example.ExpectedTools {
			tool, ok := toolLookup[strings.ToLower(toolName)]
			if !ok || !isExecutableTool(tool) {
				allExecutable = false
				break
			}
		}
		if !allExecutable {
			continue
		}
		selected = append(selected, example)
		if len(selected) == max {
			return selected
		}
	}
	return selected
}

func exampleValueForParam(prompt, param string) interface{} {
	switch strings.ToLower(param) {
	case "vendor_id":
		if vendor := firstMatch(prompt, `(?i)\b(VEND|V)[-_ ]?\d+\b`); vendor != "" {
			return strings.ReplaceAll(vendor, " ", "-")
		}
	case "quantity", "received_quantity":
		if quantity := firstNumber(prompt); quantity > 0 {
			return quantity
		}
	case "item_id", "item_code":
		if item := firstMatch(prompt, `(?i)\b(ITEM|LAPTOP)[-_ ]?\d*\b`); item != "" {
			return strings.ToUpper(strings.ReplaceAll(item, " ", "-"))
		}
	case "approval_reason":
		return "Policy threshold or role control requires approval."
	case "approver_role":
		return "manager"
	case "event_type":
		return "workflow.generated"
	case "actor_role":
		return "{{input.user_role}}"
	case "decision":
		return "candidate_generated"
	}
	return "{{input." + param + "}}"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func isExecutableTool(tool registry.Tool) bool {
	status := strings.ToLower(strings.TrimSpace(tool.Status))
	return status == "" || status == "active_mcp_schema_present"
}

func firstMatch(value, pattern string) string {
	re := regexp.MustCompile(pattern)
	return strings.TrimSpace(re.FindString(value))
}

func firstNumber(value string) int {
	re := regexp.MustCompile(`\b\d+\b`)
	raw := re.FindString(value)
	if raw == "" {
		return 0
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return parsed
}

func yamlScalar(value interface{}) string {
	switch typed := value.(type) {
	case int:
		return strconv.Itoa(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return fmt.Sprintf("%q", fmt.Sprint(typed))
	}
}

func safeID(value string) string {
	value = strings.ToLower(value)
	value = strings.NewReplacer(".", "_", "-", "_", " ", "_").Replace(value)
	return value
}

func limitCandidates(candidates []WorkflowCandidate, max int) []WorkflowCandidate {
	if max <= 0 || len(candidates) <= max {
		return candidates
	}
	return candidates[:max]
}

func redactPromptText(value string) string {
	sensitive := regexp.MustCompile(`(?i)(api[_-]?key|token|password|secret|authorization|auth[_-]?header|private[_-]?key)\s*[:=]\s*\S+`)
	return sensitive.ReplaceAllString(value, "$1: [REDACTED]")
}
