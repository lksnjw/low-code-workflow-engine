package handlers

import (
	"net/http"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) ToolsCatalog(c *fiber.Ctx) error {
	if h.Dataset == nil || h.Dataset.Tools == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "tool registry is not loaded")
	}
	module := strings.ToLower(strings.TrimSpace(c.Query("module")))
	role := strings.ToLower(strings.TrimSpace(c.Query("role")))
	if role == "" {
		if user := h.currentUser(c); user != nil {
			role = strings.ToLower(user.Role.Name)
		}
	}
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))

	items := []map[string]interface{}{}
	for _, tool := range h.Dataset.Tools.GetAllTools() {
		if module != "" && strings.ToLower(tool.Module) != module {
			continue
		}
		if status != "" && strings.ToLower(tool.Status) != status {
			continue
		}
		if role != "" && !catalogRoleAllowed(role, tool.AllowedRoles) {
			continue
		}
		items = append(items, map[string]interface{}{
			"tool_id":             tool.ToolID,
			"name":                tool.Name,
			"display_name":        tool.DisplayName,
			"erp_system":          tool.ERPSystem,
			"module":              tool.Module,
			"status":              tool.Status,
			"description":         tool.Description,
			"required_parameters": tool.RequiredParameters,
			"optional_parameters": tool.OptionalParameters,
			"allowed_roles":       tool.AllowedRoles,
			"risk_level":          tool.RiskLevel,
			"is_read_only":        tool.IsReadOnly,
			"source_file":         tool.SourceFile,
		})
	}
	return c.JSON(models.OK(items, "Tool catalog loaded", map[string]interface{}{"count": len(items)}))
}

func (h *Handler) SemanticServiceHealth(c *fiber.Ctx) error {
	if h.Search == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(models.Fail("semantic search service is not configured", nil))
	}
	payload, err := h.Search.ExternalStatus(c.Context(), http.MethodGet, "/health")
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(models.Fail(err.Error(), nil))
	}
	return c.JSON(models.OK(payload, "Semantic search service health loaded", nil))
}

func (h *Handler) SemanticIndexMetadata(c *fiber.Ctx) error {
	if h.Search == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(models.Fail("semantic search service is not configured", nil))
	}
	payload, err := h.Search.ExternalStatus(c.Context(), http.MethodGet, "/index/status")
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(models.Fail(err.Error(), nil))
	}
	return c.JSON(models.OK(payload, "Semantic index metadata loaded", nil))
}

func (h *Handler) RebuildSemanticIndex(c *fiber.Ctx) error {
	if h.Search == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(models.Fail("semantic search service is not configured", nil))
	}
	payload, err := h.Search.ExternalStatus(c.Context(), http.MethodPost, "/index/rebuild")
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(models.Fail(err.Error(), nil))
	}
	return c.JSON(models.OK(payload, "Semantic index rebuilt", nil))
}

func (h *Handler) RulesCatalog(c *fiber.Ctx) error {
	if h.Dataset == nil || h.Dataset.Rules == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "rule registry is not loaded")
	}
	domain := strings.ToLower(strings.TrimSpace(c.Query("domain")))
	enabledFilter := strings.ToLower(strings.TrimSpace(c.Query("enabled")))

	items := []map[string]interface{}{}
	for _, rule := range h.Dataset.Rules.GetAllRules() {
		if domain != "" && strings.ToLower(rule.Domain) != domain {
			continue
		}
		if enabledFilter != "" {
			wantEnabled := enabledFilter == "true" || enabledFilter == "1" || enabledFilter == "yes"
			if rule.Enabled != wantEnabled {
				continue
			}
		}
		items = append(items, map[string]interface{}{
			"rule_id":                rule.RuleID,
			"rule_name":              rule.RuleName,
			"rule_type":              rule.RuleType,
			"erp_system":             rule.ERPSystem,
			"domain":                 rule.Domain,
			"description":            rule.Description,
			"applies_to_tools":       rule.AppliesToTools,
			"applies_to_roles":       rule.AppliesToRoles,
			"enforcement_action":     rule.EnforcementAction,
			"severity":               rule.Severity,
			"validator_message":      rule.ValidatorMessage,
			"llm_prompt_instruction": rule.LLMPromptInstruction,
			"enabled":                rule.Enabled,
			"source_file":            rule.SourceFile,
		})
	}
	return c.JSON(models.OK(items, "Rule catalog loaded", map[string]interface{}{"count": len(items)}))
}

func (h *Handler) SemanticSearch(c *fiber.Ctx) error {
	if h.Search == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "semantic search is not configured")
	}
	body := decodeMap(c)
	query := strings.TrimSpace(asString(body["query"]))
	if query == "" {
		return fiber.NewError(fiber.StatusBadRequest, "query is required")
	}
	userRole := "anonymous"
	if user := h.currentUser(c); user != nil {
		userRole = user.Role.Name
	}
	result, err := h.Search.SearchContext(c.Context(), query, userRole, semanticsearch.Options{
		TopKTools:     toInt(body["top_k_tools"], h.Cfg.SemanticSearchTopKTools),
		TopKRules:     toInt(body["top_k_rules"], h.Cfg.SemanticSearchTopKRules),
		TopKTemplates: toInt(body["top_k_templates"], h.Cfg.SemanticSearchTopKTemplates),
		TopKExamples:  toInt(body["top_k_examples"], h.Cfg.SemanticSearchTopKExamples),
	})
	if err != nil {
		return fiber.NewError(fiber.StatusBadGateway, err.Error())
	}
	return c.JSON(models.OK(result, "Semantic search completed", nil))
}

func (h *Handler) CanvasValidateWorkflow(c *fiber.Ctx) error {
	body := decodeMap(c)
	yamlText := strings.TrimSpace(asString(body["yaml"]))
	if yamlText == "" {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Canvas node/edge to YAML conversion is not implemented yet. Provide yaml for validation.", map[string]interface{}{
			"code":          "CANVAS_CONVERSION_NOT_IMPLEMENTED",
			"suggested_fix": "Send frontend-generated YAML in the yaml field, then the backend will validate it with the full semantic validator.",
		}))
	}
	_, result, err := h.validateWithFullGate(c, "CanvasValidateWorkflow", yamlText)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	stepErrors := []map[string]interface{}{}
	if result.ParsedWorkflow != nil {
		for _, step := range result.ParsedWorkflow.Steps {
			for _, errText := range result.Errors {
				if strings.Contains(errText, step.ID) || strings.Contains(errText, step.Action) {
					stepErrors = append(stepErrors, map[string]interface{}{
						"step_id":       step.ID,
						"action":        step.Action,
						"message":       errText,
						"suggested_fix": "Check tool existence, required parameters, role permissions, and process order.",
					})
				}
			}
		}
	}
	return c.JSON(models.OK(map[string]interface{}{"validation": result, "step_errors": stepErrors}, "Canvas workflow validation completed", nil))
}

func catalogRoleAllowed(role string, allowed []string) bool {
	if role == "" || len(allowed) == 0 {
		return true
	}
	role = strings.ReplaceAll(strings.ToLower(role), " ", "_")
	if role == "platform_admin" {
		role = "admin"
	}
	for _, item := range allowed {
		normalized := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(item)), " ", "_")
		if normalized == role || role == "admin" {
			return true
		}
	}
	return false
}

func asString(value interface{}) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
