package handlers

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func (h *Handler) DashboardSummary(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	activeWorkflows := 0
	for _, workflow := range h.Store.Workflows {
		if !workflow.Archived {
			activeWorkflows++
		}
	}
	successfulRuns := 0
	finishedRuns := 0
	totalLatency := int64(0)
	latencySamples := 0
	for _, execution := range h.Store.Executions {
		if execution.Status == models.StatusDone {
			successfulRuns++
			finishedRuns++
		} else if execution.Status == models.StatusFailed {
			finishedRuns++
		}
		if execution.CompletedAt != nil {
			totalLatency += execution.DurationMS
			latencySamples++
		}
	}
	healingWins := 0
	for _, report := range h.Store.Healing {
		if strings.EqualFold(report.Status, "repaired") || strings.EqualFold(report.Status, "recovered") {
			healingWins++
		}
	}
	h.Store.Mu.RUnlock()

	successRate := 0.0
	if finishedRuns > 0 {
		successRate = float64(successfulRuns) / float64(finishedRuns) * 100
	}
	avgLatency := int64(0)
	if latencySamples > 0 {
		avgLatency = totalLatency / int64(latencySamples)
	}
	metrics := []map[string]interface{}{
		metric("activeWorkflows", "Active Workflows", activeWorkflows, fmt.Sprintf("%d", activeWorkflows), "tabler:git-branch", "primary"),
		metric("successfulRuns", "Successful Runs", successRate, fmt.Sprintf("%.1f%%", successRate), "mdi:check-decagram-outline", "green"),
		metric("avgLatency", "Avg Latency", avgLatency, formatDurationMS(avgLatency), "mdi:timer-outline", "blue"),
		metric("healingWins", "Healing Wins", healingWins, fmt.Sprintf("%d", healingWins), "mdi:shield-refresh-outline", "purple"),
	}
	return c.JSON(models.OK(map[string]interface{}{"metrics": metrics}, "OK", map[string]interface{}{"range": c.Query("range", "7d"), "timezone": c.Query("timezone", "UTC")}))
}

func (h *Handler) DashboardActivity(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	activity := make([]map[string]interface{}, 0, len(h.Store.AuditLogs)+len(h.Store.Executions)+len(h.Store.Healing))
	for _, log := range h.Store.AuditLogs {
		activity = append(activity, map[string]interface{}{
			"id": log.ID, "title": humanizeAction(log.Action), "description": resourceDescription(log.Resource),
			"type": "audit", "tone": "blue", "icon": "mdi:clipboard-text-clock-outline",
			"createdAt": log.CreatedAt, "actor": log.Actor, "resource": log.Resource,
		})
	}
	for _, execution := range h.Store.Executions {
		createdAt := execution.StartedAt
		if execution.CompletedAt != nil {
			createdAt = *execution.CompletedAt
		}
		activity = append(activity, map[string]interface{}{
			"id":          "activity_" + execution.ID,
			"title":       fmt.Sprintf("%s execution %s", execution.WorkflowName, strings.ToLower(execution.Status)),
			"description": fmt.Sprintf("Execution %s", execution.ID), "type": "execution",
			"tone": executionTone(execution.Status), "icon": "mdi:play-circle-outline", "createdAt": createdAt,
			"actor": execution.StartedBy, "resource": models.ResourceRef{Type: "execution", ID: execution.ID},
		})
	}
	for _, report := range h.Store.Healing {
		createdAt := time.Time{}
		if execution := h.Store.Executions[report.ExecutionID]; execution != nil {
			createdAt = execution.StartedAt
		}
		activity = append(activity, map[string]interface{}{
			"id": "healing_" + report.ExecutionID, "title": "Self-healing " + strings.ToLower(report.Status),
			"description": report.Summary, "type": "healing", "tone": "purple", "icon": "mdi:shield-refresh-outline",
			"createdAt": createdAt, "actor": models.Principal{ID: "system", Name: "Execution Engine"},
			"resource": models.ResourceRef{Type: "execution", ID: report.ExecutionID},
		})
	}
	h.Store.Mu.RUnlock()
	sort.Slice(activity, func(i, j int) bool { return activityTime(activity[i]).After(activityTime(activity[j])) })
	if len(activity) > 20 {
		activity = activity[:20]
	}
	return c.JSON(models.OK(activity, "OK", map[string]interface{}{"nextCursor": nil}))
}

func (h *Handler) DashboardHealth(c *fiber.Ctx) error {
	now := time.Now().UTC()
	providerReady := !strings.EqualFold(h.Cfg.WorkflowGenerationProvider, "gemini") || strings.TrimSpace(h.Cfg.GeminiAPIKey) != ""
	mcpReady := strings.TrimSpace(h.Cfg.MCPBaseURL) != ""
	services := []map[string]interface{}{
		healthService("Synthesis API", providerReady, fmt.Sprintf("provider=%s model=%s", h.Cfg.WorkflowGenerationProvider, h.Cfg.GeminiModel), now),
		healthService("Execution Engine", h.Runner != nil, "in-process governed runner", now),
		healthService("MCP Bridge", mcpReady, configuredMeta(mcpReady, h.Cfg.MCPBaseURL), now),
		healthService("Policy Gate", h.RegistryValidator != nil, "registry validation required", now),
	}
	overall := "healthy"
	for _, service := range services {
		if service["status"] != "healthy" {
			overall = "degraded"
			break
		}
	}
	return c.JSON(models.OK(map[string]interface{}{"overall": overall, "services": services}, "OK", nil))
}

func (h *Handler) RecentWorkflows(c *fiber.Ctx) error {
	limit := c.QueryInt("limit", 5)
	h.Store.Mu.RLock()
	items := repository.ListMapValues(h.Store.Workflows)
	h.Store.Mu.RUnlock()
	repository.SortWorkflows(items)
	if limit > 0 && limit < len(items) {
		items = items[:limit]
	}
	return c.JSON(models.OK(items, "OK", nil))
}

func metric(key, label string, value interface{}, formatted, icon, tone string) map[string]interface{} {
	return map[string]interface{}{"key": key, "label": label, "value": value, "formattedValue": formatted, "delta": "", "trend": "neutral", "icon": icon, "tone": tone}
}

func formatDurationMS(value int64) string {
	if value <= 0 {
		return "0ms"
	}
	if value < 1000 {
		return fmt.Sprintf("%dms", value)
	}
	return fmt.Sprintf("%.1fs", float64(value)/1000)
}

func humanizeAction(action string) string {
	words := strings.Fields(strings.NewReplacer(".", " ", "_", " ", "-", " ").Replace(action))
	for index, word := range words {
		if word != "" {
			words[index] = strings.ToUpper(word[:1]) + word[1:]
		}
	}
	return strings.Join(words, " ")
}

func resourceDescription(resource models.ResourceRef) string {
	if resource.Type == "" {
		return "Platform activity"
	}
	return fmt.Sprintf("%s %s", humanizeAction(resource.Type), resource.ID)
}

func executionTone(status string) string {
	switch status {
	case models.StatusDone:
		return "green"
	case models.StatusFailed:
		return "amber"
	case models.StatusHealing:
		return "purple"
	default:
		return "blue"
	}
}

func activityTime(item map[string]interface{}) time.Time {
	value, _ := item["createdAt"].(time.Time)
	return value
}

func healthService(name string, ready bool, meta string, checkedAt time.Time) map[string]interface{} {
	status := "unavailable"
	value := 0
	if ready {
		status = "healthy"
		value = 100
	}
	return map[string]interface{}{"name": name, "status": status, "value": value, "meta": meta, "lastCheckedAt": checkedAt}
}

func configuredMeta(ready bool, value string) string {
	if !ready {
		return "not configured"
	}
	return value
}
