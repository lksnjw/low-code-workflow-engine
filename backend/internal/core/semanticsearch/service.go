package semanticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

type Service struct {
	Tools                *registry.ToolRegistry
	Rules                *registry.RuleRegistry
	Templates            []registry.ProcessTemplate
	Examples             []registry.FewShotExample
	DefaultMode          string
	ExternalURL          string
	AllowLexicalFallback bool
	HTTP                 *http.Client
	toolDocs             map[string]searchDocument
	ruleDocs             map[string]searchDocument
	templateDocs         map[string]searchDocument
	exampleDocs          map[string]searchDocument
}

// ExternalStatus calls an operational endpoint on the configured semantic
// search service. It keeps service discovery on the backend and avoids
// exposing an internal service URL to browsers.
func (s *Service) ExternalStatus(ctx context.Context, method, path string) (interface{}, error) {
	if strings.TrimSpace(s.ExternalURL) == "" {
		return nil, fmt.Errorf("semantic search service is not configured")
	}
	base, err := url.Parse(s.ExternalURL)
	if err != nil {
		return nil, fmt.Errorf("invalid semantic search URL: %w", err)
	}
	base.Path = path
	base.RawQuery = ""
	request, err := http.NewRequestWithContext(ctx, method, base.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := s.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("semantic search service unavailable: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("semantic search service returned HTTP %d", response.StatusCode)
	}
	var payload interface{}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode semantic search status: %w", err)
	}
	return payload, nil
}

type searchDocument struct {
	Text   string
	Tokens map[string]bool
}

func NewService(tools *registry.ToolRegistry, rules *registry.RuleRegistry, defaultMode string) *Service {
	if defaultMode == "" {
		defaultMode = "go_lexical"
	}
	service := &Service{Tools: tools, Rules: rules, DefaultMode: defaultMode, AllowLexicalFallback: true, HTTP: &http.Client{Timeout: 30 * time.Second}}
	service.buildLexicalCache()
	return service
}

func NewServiceFromDataset(bundle *registry.Bundle, defaultMode, externalURL string, allowLexicalFallback bool) *Service {
	if defaultMode == "" {
		defaultMode = "external_embedding"
	}
	service := &Service{
		Tools:                bundle.Tools,
		Rules:                bundle.Rules,
		Templates:            bundle.Templates,
		Examples:             bundle.Examples,
		DefaultMode:          defaultMode,
		ExternalURL:          externalURL,
		AllowLexicalFallback: allowLexicalFallback,
		HTTP:                 &http.Client{Timeout: 30 * time.Second},
	}
	service.buildLexicalCache()
	return service
}

func (s *Service) SearchContext(ctx context.Context, query, userRole string, options Options) (Result, error) {
	if options.TopKTools <= 0 {
		options.TopKTools = 10
	}
	if options.TopKRules <= 0 {
		options.TopKRules = 15
	}
	if options.TopKTemplates <= 0 {
		options.TopKTemplates = 5
	}
	if options.TopKExamples <= 0 {
		options.TopKExamples = 5
	}
	mode := options.Mode
	if mode == "" {
		mode = s.DefaultMode
	}
	if strings.EqualFold(mode, "external_embedding") {
		result, err := s.searchExternal(ctx, query, userRole, options)
		if err == nil {
			return result, nil
		}
		if !s.AllowLexicalFallback {
			return Result{}, err
		}
		mode = "go_lexical"
	}

	return s.searchLexical(query, userRole, options, mode), nil
}

func (s *Service) searchLexical(query, userRole string, options Options, mode string) Result {
	tools := s.rankTools(query, userRole)
	rules := s.rankRules(query, tools)
	global := s.globalRules(query)
	templates := s.rankTemplates(query)
	examples := s.rankExamples(query)

	if len(tools) > options.TopKTools {
		tools = tools[:options.TopKTools]
	}
	if len(rules) > options.TopKRules {
		rules = rules[:options.TopKRules]
	}
	if len(templates) > options.TopKTemplates {
		templates = templates[:options.TopKTemplates]
	}
	if len(examples) > options.TopKExamples {
		examples = examples[:options.TopKExamples]
	}

	return Result{
		Tools:           tools,
		Rules:           rules,
		GlobalRules:     global,
		Templates:       templates,
		Examples:        examples,
		Query:           query,
		UserRole:        userRole,
		Method:          mode,
		RetrievalMethod: mode,
	}
}

func (s *Service) searchExternal(ctx context.Context, query, userRole string, options Options) (Result, error) {
	if strings.TrimSpace(s.ExternalURL) == "" {
		return Result{}, fmt.Errorf("semantic search mode external_embedding requires SEMANTIC_SEARCH_URL")
	}
	body, err := json.Marshal(map[string]interface{}{
		"query":           query,
		"user_role":       userRole,
		"top_k_tools":     options.TopKTools,
		"top_k_rules":     options.TopKRules,
		"top_k_templates": options.TopKTemplates,
		"top_k_examples":  options.TopKExamples,
	})
	if err != nil {
		return Result{}, fmt.Errorf("encode semantic search request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.ExternalURL, bytes.NewReader(body))
	if err != nil {
		return Result{}, fmt.Errorf("create semantic search request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("embedding semantic search unavailable at %s: %w", s.ExternalURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return Result{}, fmt.Errorf("embedding semantic search returned %d", resp.StatusCode)
	}
	var payload externalResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return Result{}, fmt.Errorf("decode semantic search response: %w", err)
	}
	return s.externalToResult(query, userRole, payload), nil
}

type externalResponse struct {
	Query           string         `json:"query"`
	RetrievalMethod string         `json:"retrieval_method"`
	Tools           []externalItem `json:"tools"`
	Rules           []externalItem `json:"rules"`
	Templates       []externalItem `json:"templates"`
	Examples        []externalItem `json:"examples"`
}

type externalItem struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	DisplayName string          `json:"display_name"`
	RuleID      string          `json:"rule_id"`
	RuleName    string          `json:"rule_name"`
	Score       float64         `json:"score"`
	MatchReason string          `json:"match_reason"`
	SourceFile  string          `json:"source_file"`
	Original    json.RawMessage `json:"original"`
}

func (s *Service) externalToResult(query, userRole string, payload externalResponse) Result {
	result := Result{
		Query:           firstNonEmpty(payload.Query, query),
		UserRole:        userRole,
		Method:          firstNonEmpty(payload.RetrievalMethod, "embedding_external"),
		RetrievalMethod: firstNonEmpty(payload.RetrievalMethod, "embedding_external"),
		GlobalRules:     s.globalRules(query),
	}
	for _, item := range payload.Tools {
		tool := registry.Tool{}
		_ = json.Unmarshal(item.Original, &tool)
		if tool.Name == "" && item.Name != "" {
			tool.Name = item.Name
		}
		if tool.ToolID == "" {
			tool.ToolID = item.ID
		}
		if tool.DisplayName == "" {
			tool.DisplayName = item.DisplayName
		}
		if tool.SourceFile == "" {
			tool.SourceFile = item.SourceFile
		}
		if found, ok := s.findAuthoritativeTool(tool); ok {
			tool = found
		}
		result.Tools = append(result.Tools, ToolResult{Tool: tool, Score: item.Score, MatchReason: firstNonEmpty(item.MatchReason, "Embedding similarity match")})
	}
	for _, item := range payload.Rules {
		rule := registry.Rule{}
		_ = json.Unmarshal(item.Original, &rule)
		if rule.RuleID == "" {
			rule.RuleID = firstNonEmpty(item.RuleID, item.ID)
		}
		if rule.RuleName == "" {
			rule.RuleName = item.RuleName
		}
		if rule.SourceFile == "" {
			rule.SourceFile = item.SourceFile
		}
		if found, ok := s.findAuthoritativeRule(rule); ok {
			rule = found
		}
		result.Rules = append(result.Rules, RuleResult{Rule: rule, Score: item.Score, MatchReason: firstNonEmpty(item.MatchReason, "Embedding similarity match")})
	}
	for _, item := range payload.Templates {
		template := registry.ProcessTemplate{}
		_ = json.Unmarshal(item.Original, &template)
		if template.TemplateID == "" {
			template.TemplateID = item.ID
		}
		if template.TemplateName == "" {
			template.TemplateName = item.Name
		}
		if template.SourceFile == "" {
			template.SourceFile = item.SourceFile
		}
		result.Templates = append(result.Templates, TemplateResult{ProcessTemplate: template, Score: item.Score, MatchReason: firstNonEmpty(item.MatchReason, "Embedding similarity match")})
	}
	for _, item := range payload.Examples {
		example := registry.FewShotExample{}
		_ = json.Unmarshal(item.Original, &example)
		if example.ScenarioID == "" {
			example.ScenarioID = item.ID
		}
		if example.SourceFile == "" {
			example.SourceFile = item.SourceFile
		}
		result.Examples = append(result.Examples, ExampleResult{FewShotExample: example, Score: item.Score, MatchReason: firstNonEmpty(item.MatchReason, "Embedding similarity match")})
	}
	return result
}

func (s *Service) findAuthoritativeTool(candidate registry.Tool) (registry.Tool, bool) {
	if s == nil || s.Tools == nil {
		return registry.Tool{}, false
	}
	for _, ref := range []string{candidate.Name, candidate.MCPToolName} {
		if strings.TrimSpace(ref) == "" {
			continue
		}
		if found, ok := s.Tools.FindToolByName(ref); ok {
			return found, true
		}
	}
	if strings.TrimSpace(candidate.ToolID) != "" {
		return s.Tools.FindToolByID(candidate.ToolID)
	}
	return registry.Tool{}, false
}

func (s *Service) findAuthoritativeRule(candidate registry.Rule) (registry.Rule, bool) {
	if s == nil || s.Rules == nil || strings.TrimSpace(candidate.RuleID) == "" {
		return registry.Rule{}, false
	}
	for _, rule := range s.Rules.GetAllRules() {
		if strings.EqualFold(rule.RuleID, candidate.RuleID) {
			return rule, true
		}
	}
	return registry.Rule{}, false
}

func (s *Service) rankTools(query, userRole string) []ToolResult {
	out := []ToolResult{}
	for _, tool := range s.Tools.GetAllTools() {
		score, matches := s.lexicalScoreForTool(query, tool)
		if queryMentionsTool(query, tool) {
			score += 0.25
		}
		if roleAllowed(userRole, tool.AllowedRoles) {
			score += 0.08
		}
		if score > 1 {
			score = 1
		}
		if score <= 0 {
			continue
		}
		out = append(out, ToolResult{Tool: tool, Score: score, MatchReason: reason(matches, "Low lexical overlap with request")})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].Name < out[j].Name
		}
		return out[i].Score > out[j].Score
	})
	return out
}

func (s *Service) rankRules(query string, tools []ToolResult) []RuleResult {
	toolRefs := map[string]bool{}
	for _, tool := range tools {
		toolRefs[strings.ToLower(tool.Name)] = true
		toolRefs[strings.ToLower(tool.ToolID)] = true
	}

	out := []RuleResult{}
	seen := map[string]bool{}
	for _, rule := range s.Rules.GetEnabledRules() {
		if strings.EqualFold(rule.Domain, "global") || strings.HasPrefix(strings.ToUpper(rule.RuleID), "GLOBAL-") {
			continue
		}
		score, matches := s.lexicalScoreForRule(query, rule)
		for _, ref := range rule.AppliesToTools {
			if toolRefs[strings.ToLower(ref)] {
				score += 0.35
			}
		}
		if score > 1 {
			score = 1
		}
		if score <= 0 {
			continue
		}
		seen[rule.RuleID] = true
		out = append(out, RuleResult{Rule: rule, Score: score, MatchReason: reason(matches, "Applies to retrieved tools")})
	}

	for _, tool := range tools {
		for _, rule := range s.Rules.FindRulesByTool(tool.Name, tool.ToolID) {
			if seen[rule.RuleID] || strings.EqualFold(rule.Domain, "global") {
				continue
			}
			seen[rule.RuleID] = true
			out = append(out, RuleResult{Rule: rule, Score: 0.72, MatchReason: "Applies to retrieved tool " + tool.Name})
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].RuleID < out[j].RuleID
		}
		return out[i].Score > out[j].Score
	})
	return out
}

func (s *Service) rankTemplates(query string) []TemplateResult {
	out := []TemplateResult{}
	for _, template := range s.Templates {
		score, matches := s.lexicalScoreForTemplate(query, template)
		if score <= 0 {
			continue
		}
		out = append(out, TemplateResult{ProcessTemplate: template, Score: score, MatchReason: reason(matches, "Template lexical match")})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Score > out[j].Score
	})
	return out
}

func (s *Service) rankExamples(query string) []ExampleResult {
	out := []ExampleResult{}
	for _, example := range s.Examples {
		score, matches := s.lexicalScoreForExample(query, example)
		if score <= 0 {
			continue
		}
		out = append(out, ExampleResult{FewShotExample: example, Score: score, MatchReason: reason(matches, "Example lexical match")})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Score > out[j].Score
	})
	return out
}

func (s *Service) globalRules(query string) []RuleResult {
	out := []RuleResult{}
	for _, rule := range s.Rules.GetGlobalSafetyRules() {
		score, matches := s.lexicalScoreForRule(query, rule)
		if score < 0.65 {
			score = 0.65
		}
		out = append(out, RuleResult{Rule: rule, Score: score, MatchReason: reason(matches, "Always included global safety rule")})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].RuleID < out[j].RuleID
	})
	return out
}

func roleAllowed(userRole string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	role := normalizeRole(userRole)
	for _, item := range allowed {
		allowedRole := normalizeRole(item)
		if allowedRole == role || allowedRole == "admin" && role == "admin" {
			return true
		}
	}
	return false
}

func normalizeRole(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, " ", "_")
	value = strings.ReplaceAll(value, "-", "_")
	if value == "platform_admin" {
		return "admin"
	}
	return value
}

func queryMentionsTool(query string, tool registry.Tool) bool {
	normalizedQuery := normalizedSearchPhrase(query)
	for _, value := range []string{tool.Name, tool.DisplayName, tool.BusinessCapability} {
		normalized := normalizedSearchPhrase(value)
		if normalized != "" && strings.Contains(normalizedQuery, normalized) {
			return true
		}
	}
	return false
}

func normalizedSearchPhrase(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.NewReplacer(".", " ", "_", " ", "-", " ").Replace(value)
	return strings.Join(strings.Fields(value), " ")
}

func (s *Service) buildLexicalCache() {
	s.toolDocs = map[string]searchDocument{}
	s.ruleDocs = map[string]searchDocument{}
	s.templateDocs = map[string]searchDocument{}
	s.exampleDocs = map[string]searchDocument{}
	if s.Tools != nil {
		for _, tool := range s.Tools.GetAllTools() {
			text := toolDocument(tool)
			s.toolDocs[strings.ToLower(firstNonEmpty(tool.ToolID, tool.Name))] = searchDocument{Text: text, Tokens: tokenSet(text)}
		}
	}
	if s.Rules != nil {
		for _, rule := range s.Rules.GetAllRules() {
			text := ruleDocument(rule)
			s.ruleDocs[strings.ToLower(rule.RuleID)] = searchDocument{Text: text, Tokens: tokenSet(text)}
		}
	}
	for _, template := range s.Templates {
		text := templateDocument(template)
		s.templateDocs[strings.ToLower(template.TemplateID)] = searchDocument{Text: text, Tokens: tokenSet(text)}
	}
	for _, example := range s.Examples {
		key := strings.ToLower(firstNonEmpty(example.ScenarioID, example.UserRequest))
		text := exampleDocument(example)
		s.exampleDocs[key] = searchDocument{Text: text, Tokens: tokenSet(text)}
	}
}

func (s *Service) lexicalScoreForTool(query string, tool registry.Tool) (float64, []string) {
	if doc, ok := s.toolDocs[strings.ToLower(firstNonEmpty(tool.ToolID, tool.Name))]; ok {
		return lexicalScoreWithDocument(query, doc)
	}
	return lexicalScore(query, toolDocument(tool))
}

func (s *Service) lexicalScoreForRule(query string, rule registry.Rule) (float64, []string) {
	if doc, ok := s.ruleDocs[strings.ToLower(rule.RuleID)]; ok {
		return lexicalScoreWithDocument(query, doc)
	}
	return lexicalScore(query, ruleDocument(rule))
}

func (s *Service) lexicalScoreForTemplate(query string, template registry.ProcessTemplate) (float64, []string) {
	if doc, ok := s.templateDocs[strings.ToLower(template.TemplateID)]; ok {
		return lexicalScoreWithDocument(query, doc)
	}
	return lexicalScore(query, templateDocument(template))
}

func (s *Service) lexicalScoreForExample(query string, example registry.FewShotExample) (float64, []string) {
	if doc, ok := s.exampleDocs[strings.ToLower(firstNonEmpty(example.ScenarioID, example.UserRequest))]; ok {
		return lexicalScoreWithDocument(query, doc)
	}
	return lexicalScore(query, exampleDocument(example))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
