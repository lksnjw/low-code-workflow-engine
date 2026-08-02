package context

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"gopkg.in/yaml.v3"
)

const (
	GeneratorVersion = 1
	DefaultSizeCap   = 60 * 1024
)

type FrontMatter struct {
	RegistryHash       string `yaml:"registry_hash" json:"registryHash"`
	ToolRegistrySHA256 string `yaml:"tool_registry_sha256" json:"toolRegistrySha256"`
	RuleRegistrySHA256 string `yaml:"rule_registry_sha256" json:"ruleRegistrySha256"`
	GeneratedAt        string `yaml:"generated_at" json:"generatedAt"`
	ToolCount          int    `yaml:"tool_count" json:"toolCount"`
	RuleCount          int    `yaml:"rule_count" json:"ruleCount"`
	GeneratorVersion   int    `yaml:"generator_version" json:"generatorVersion"`
}

type Document struct {
	FrontMatter   FrontMatter `json:"frontMatter"`
	Markdown      string      `json:"markdown"`
	Body          string      `json:"body"`
	Path          string      `json:"path,omitempty"`
	SizeBytes     int         `json:"sizeBytes"`
	TokenEstimate int         `json:"tokenEstimate"`
	Stale         bool        `json:"stale"`
}

type RenderInput struct {
	RegistryHash       string
	ToolRegistrySHA256 string
	RuleRegistrySHA256 string
	GeneratedAt        time.Time
	Tools              []registry.Tool
	Rules              []registry.Rule
	SizeCapBytes       int
}

type renderedDomain struct {
	Name     string
	Tools    []registry.Tool
	Full     string
	NameOnly string
}

// Render is pure: all time and registry inputs are supplied by the caller.
func Render(input RenderInput) (Document, error) {
	sizeCap := input.SizeCapBytes
	if sizeCap <= 0 {
		sizeCap = DefaultSizeCap
	}
	activeTools := activeTools(input.Tools)
	activeRules := activeRules(input.Rules)
	domains := groupToolsByDomain(activeTools)
	policy, process, err := renderRules(activeRules, activeTools)
	if err != nil {
		return Document{}, err
	}
	sensitive := renderSensitiveFields(workflowvalidator.SensitiveFieldNames())
	domainIndex := renderDomainIndex(domains)
	bodyFor := func(fullDomains map[string]bool) string {
		var body strings.Builder
		fmt.Fprintf(&body, "<!-- registry_sha256: %s -->\n\n", input.RegistryHash)
		body.WriteString("# Runtime Registry Generation Context\n\n")
		body.WriteString("## 1. DOMAIN INDEX\n\n")
		body.WriteString(domainIndex)
		body.WriteString("\n## 2. TOOL CATALOGUE\n\n")
		for _, domain := range domains {
			if fullDomains[domain.Name] {
				body.WriteString(domain.Full)
			} else {
				body.WriteString(domain.NameOnly)
			}
		}
		body.WriteString("\n## 3. POLICY CONSTRAINTS\n\n")
		body.WriteString(policy)
		body.WriteString("\n## 4. PROCESS CONSTRAINTS\n\n")
		body.WriteString(process)
		body.WriteString("\n## 5. SENSITIVE FIELDS\n\n")
		body.WriteString(sensitive)
		return body.String()
	}

	frontMatter := FrontMatter{
		RegistryHash:       input.RegistryHash,
		ToolRegistrySHA256: input.ToolRegistrySHA256,
		RuleRegistrySHA256: input.RuleRegistrySHA256,
		GeneratedAt:        input.GeneratedAt.UTC().Format(time.RFC3339),
		ToolCount:          len(activeTools),
		RuleCount:          len(activeRules),
		GeneratorVersion:   GeneratorVersion,
	}
	fullDomains := map[string]bool{}
	for _, domain := range domains {
		fullDomains[domain.Name] = true
	}
	body := bodyFor(fullDomains)
	markdown, err := combineDocument(frontMatter, body)
	if err != nil {
		return Document{}, err
	}
	if len(markdown) > sizeCap {
		fullDomains = map[string]bool{}
		minimalBody := bodyFor(fullDomains)
		minimal, combineErr := combineDocument(frontMatter, minimalBody)
		if combineErr != nil {
			return Document{}, combineErr
		}
		if len(minimal) > sizeCap {
			return Document{}, fmt.Errorf("registry context minimum domain index is %d bytes and exceeds size cap %d", len(minimal), sizeCap)
		}
		for _, domain := range domains {
			fullDomains[domain.Name] = true
			candidateBody := bodyFor(fullDomains)
			candidate, combineErr := combineDocument(frontMatter, candidateBody)
			if combineErr != nil {
				return Document{}, combineErr
			}
			if len(candidate) > sizeCap {
				delete(fullDomains, domain.Name)
			}
		}
		body = bodyFor(fullDomains)
		markdown, err = combineDocument(frontMatter, body)
		if err != nil {
			return Document{}, err
		}
	}
	if len(markdown) > sizeCap {
		return Document{}, fmt.Errorf("registry context is %d bytes and exceeds size cap %d", len(markdown), sizeCap)
	}
	return Document{
		FrontMatter:   frontMatter,
		Markdown:      markdown,
		Body:          body,
		SizeBytes:     len(markdown),
		TokenEstimate: tokenEstimate(markdown),
	}, nil
}

func Parse(markdown []byte) (Document, error) {
	if !bytes.HasPrefix(markdown, []byte("---\n")) {
		return Document{}, errors.New("registry context is missing YAML front matter")
	}
	separator := bytes.Index(markdown[4:], []byte("\n---\n"))
	if separator < 0 {
		return Document{}, errors.New("registry context front matter is not terminated")
	}
	separator += 4
	var frontMatter FrontMatter
	if err := yaml.Unmarshal(markdown[4:separator], &frontMatter); err != nil {
		return Document{}, fmt.Errorf("parse registry context front matter: %w", err)
	}
	bodyStart := separator + len("\n---\n")
	body := string(markdown[bodyStart:])
	return Document{
		FrontMatter:   frontMatter,
		Markdown:      string(markdown),
		Body:          body,
		SizeBytes:     len(markdown),
		TokenEstimate: tokenEstimate(string(markdown)),
	}, nil
}

func combineDocument(frontMatter FrontMatter, body string) (string, error) {
	raw, err := yaml.Marshal(frontMatter)
	if err != nil {
		return "", fmt.Errorf("render registry context front matter: %w", err)
	}
	return "---\n" + string(raw) + "---\n" + body, nil
}

func activeTools(tools []registry.Tool) []registry.Tool {
	out := make([]registry.Tool, 0, len(tools))
	for _, tool := range tools {
		if strings.EqualFold(strings.TrimSpace(tool.Status), "active_mcp_schema_present") {
			out = append(out, tool)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		leftModule := strings.ToLower(strings.TrimSpace(out[i].Module))
		rightModule := strings.ToLower(strings.TrimSpace(out[j].Module))
		if leftModule == rightModule {
			return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
		}
		return leftModule < rightModule
	})
	return out
}

func activeRules(rules []registry.Rule) []registry.Rule {
	out := make([]registry.Rule, 0, len(rules))
	for _, rule := range rules {
		if rule.Enabled {
			out = append(out, rule)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].RuleID) < strings.ToLower(out[j].RuleID)
	})
	return out
}

func groupToolsByDomain(tools []registry.Tool) []renderedDomain {
	grouped := map[string][]registry.Tool{}
	for _, tool := range tools {
		domain := strings.TrimSpace(tool.Module)
		if domain == "" {
			domain = "unclassified"
		}
		grouped[domain] = append(grouped[domain], tool)
	}
	names := make([]string, 0, len(grouped))
	for name := range grouped {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	out := make([]renderedDomain, 0, len(names))
	for _, name := range names {
		toolsForDomain := grouped[name]
		sort.Slice(toolsForDomain, func(i, j int) bool {
			return strings.ToLower(toolsForDomain[i].Name) < strings.ToLower(toolsForDomain[j].Name)
		})
		var full strings.Builder
		fmt.Fprintf(&full, "### %s\n\n", cleanText(name))
		for _, tool := range toolsForDomain {
			full.WriteString(renderTool(tool))
		}
		var nameOnly strings.Builder
		fmt.Fprintf(&nameOnly, "### %s (name-only)\n\n", cleanText(name))
		for _, tool := range toolsForDomain {
			fmt.Fprintf(&nameOnly, "- `%s`\n", cleanText(tool.Name))
		}
		nameOnly.WriteString("\n")
		out = append(out, renderedDomain{Name: name, Tools: toolsForDomain, Full: full.String(), NameOnly: nameOnly.String()})
	}
	return out
}

func renderDomainIndex(domains []renderedDomain) string {
	var out strings.Builder
	for _, domain := range domains {
		fmt.Fprintf(&out, "- **%s** — %d active tool(s)\n", cleanText(domain.Name), len(domain.Tools))
	}
	if len(domains) == 0 {
		out.WriteString("No active tool domains.\n")
	}
	return out.String()
}

func renderTool(tool registry.Tool) string {
	var out strings.Builder
	fmt.Fprintf(&out, "#### `%s`\n\n", cleanText(tool.Name))
	fmt.Fprintf(&out, "- **DisplayName:** %s\n", cleanText(tool.DisplayName))
	fmt.Fprintf(&out, "- **Description:** %s\n", cleanText(tool.Description))
	fmt.Fprintf(&out, "- **BusinessCapability:** %s\n", cleanText(tool.BusinessCapability))
	fmt.Fprintf(&out, "- **InputSchema parameters:** %s\n", renderParameters(tool.InputSchema))
	fmt.Fprintf(&out, "- **RequiredParameters:** %s\n", renderStringList(tool.RequiredParameters))
	fmt.Fprintf(&out, "- **OptionalParameters:** %s\n", renderStringList(tool.OptionalParameters))
	fmt.Fprintf(&out, "- **AllowedRoles:** %s\n", renderStringList(tool.AllowedRoles))
	fmt.Fprintf(&out, "- **RiskLevel:** %s\n", cleanText(tool.RiskLevel))
	fmt.Fprintf(&out, "- **IsReadOnly:** %t\n", tool.IsReadOnly)
	fmt.Fprintf(&out, "- **SideEffects:** %s\n", renderStringList(tool.SideEffects))
	fmt.Fprintf(&out, "- **PromptUsageGuidance:** %s\n\n", cleanText(tool.PromptUsageGuidance))
	return out.String()
}

func renderParameters(schema map[string]interface{}) string {
	rawProperties, ok := schema["properties"]
	if !ok {
		return "none"
	}
	properties, ok := rawProperties.(map[string]interface{})
	if !ok || len(properties) == 0 {
		return "none"
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	rendered := make([]string, 0, len(names))
	for _, name := range names {
		parameterType := "unspecified"
		if definition, ok := properties[name].(map[string]interface{}); ok {
			if value, exists := definition["type"]; exists {
				parameterType = canonicalValue(value)
			}
		}
		rendered = append(rendered, fmt.Sprintf("`%s` (%s)", cleanText(name), cleanText(parameterType)))
	}
	return strings.Join(rendered, ", ")
}

func renderRules(rules []registry.Rule, tools []registry.Tool) (string, string, error) {
	toolLookup := map[string]string{}
	for _, tool := range tools {
		toolLookup[strings.ToLower(strings.TrimSpace(tool.Name))] = tool.Name
		toolLookup[strings.ToLower(strings.TrimSpace(tool.ToolID))] = tool.Name
	}
	policyByTarget := map[string][]string{}
	process := []string{}
	for _, rule := range rules {
		target := ruleTarget(rule, toolLookup)
		sentence, err := renderRuleSentence(target, rule)
		if err != nil {
			return "", "", err
		}
		if rule.RuleType == "process_order" || rule.RuleType == "separation_of_duties" {
			process = append(process, sentence)
			continue
		}
		policyByTarget[target] = append(policyByTarget[target], sentence)
	}
	targets := make([]string, 0, len(policyByTarget))
	for target := range policyByTarget {
		targets = append(targets, target)
	}
	sort.Slice(targets, func(i, j int) bool { return strings.ToLower(targets[i]) < strings.ToLower(targets[j]) })
	var policy strings.Builder
	for _, target := range targets {
		fmt.Fprintf(&policy, "### `%s`\n\n", cleanText(target))
		sort.Strings(policyByTarget[target])
		for _, sentence := range policyByTarget[target] {
			fmt.Fprintf(&policy, "- %s\n", sentence)
		}
		policy.WriteString("\n")
	}
	if len(targets) == 0 {
		policy.WriteString("No active policy constraints.\n")
	}
	sort.Strings(process)
	var processText strings.Builder
	for _, sentence := range process {
		fmt.Fprintf(&processText, "- %s\n", sentence)
	}
	if len(process) == 0 {
		processText.WriteString("No active process constraints.\n")
	}
	return policy.String(), processText.String(), nil
}

func renderRuleSentence(target string, rule registry.Rule) (string, error) {
	key := strings.ToLower(strings.TrimSpace(rule.RuleType)) + "|" + strings.TrimSpace(rule.Condition.Operator)
	parameter := cleanText(rule.Condition.Parameter)
	value := cleanText(canonicalValue(rule.Condition.Value))
	var statement string
	switch key {
	case "execution_safety|exists":
		statement = fmt.Sprintf("%s must reference a registered tool", parameter)
	case "data_confidentiality|not_exists":
		statement = fmt.Sprintf("%s must not contain %s", parameter, value)
	case "risk_escalation|>=":
		statement = fmt.Sprintf("%s must trigger %s when it is greater than or equal to %s", parameter, cleanText(rule.EnforcementAction), value)
	case "audit|==":
		statement = fmt.Sprintf("%s equal to %s requires %s", parameter, value, cleanText(rule.EnforcementAction))
	case "parameter_required|exists":
		statement = fmt.Sprintf("%s must contain %s", parameter, value)
	case "quantity_threshold|>", "amount_threshold|>":
		statement = fmt.Sprintf("%s greater than %s requires %s", parameter, value, cleanText(rule.EnforcementAction))
	case "rbac|==":
		statement = fmt.Sprintf("%s equal to %s is subject to %s", parameter, value, cleanText(rule.EnforcementAction))
	case "capability_gap|!=":
		statement = fmt.Sprintf("%s not equal to %s requires %s", parameter, value, cleanText(rule.EnforcementAction))
	case "process_order|before":
		statement = fmt.Sprintf("%s must preserve this order: %s", parameter, value)
	case "separation_of_duties|!=":
		statement = fmt.Sprintf("%s must identify different authorized people", parameter)
	default:
		return "", fmt.Errorf("active rule %s has no deterministic rendering template for RuleType %q and operator %q", rule.RuleID, rule.RuleType, rule.Condition.Operator)
	}
	sentence := fmt.Sprintf("`%s` — %s (rule `%s`, severity %s).", cleanText(target), statement, cleanText(rule.RuleID), cleanText(rule.Severity))
	if strings.TrimSpace(rule.LLMPromptInstruction) != "" {
		sentence += " " + strings.TrimSpace(rule.LLMPromptInstruction)
	}
	return sentence, nil
}

func ruleTarget(rule registry.Rule, lookup map[string]string) string {
	for _, reference := range rule.AppliesToTools {
		if name := lookup[strings.ToLower(strings.TrimSpace(reference))]; name != "" {
			return name
		}
	}
	if strings.TrimSpace(rule.Domain) != "" {
		return rule.Domain
	}
	return "global"
}

func renderSensitiveFields(fields []string) string {
	values := append([]string{}, fields...)
	sort.Strings(values)
	var out strings.Builder
	out.WriteString("The deterministic validator scans parameter keys for these case-insensitive field-name fragments:\n\n")
	for _, field := range values {
		fmt.Fprintf(&out, "- `%s`\n", cleanText(field))
	}
	return out.String()
}

func renderStringList(values []string) string {
	if len(values) == 0 {
		return "none"
	}
	out := append([]string{}, values...)
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i]) < strings.ToLower(out[j]) })
	for index := range out {
		out[index] = "`" + cleanText(out[index]) + "`"
	}
	return strings.Join(out, ", ")
}

func canonicalValue(value interface{}) string {
	if value == nil {
		return "null"
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(raw)
}

func cleanText(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func tokenEstimate(value string) int {
	if value == "" {
		return 0
	}
	return (len([]byte(value)) + 3) / 4
}
