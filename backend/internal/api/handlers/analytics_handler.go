package handlers

import (
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) AnalyticsSummary(c *fiber.Ctx) error {
	executions, reports := h.analyticsSnapshot()
	today := time.Now().UTC().Format("2006-01-02")
	runsToday := 0
	finished := 0
	succeeded := 0
	totalLatency := int64(0)
	latencySamples := 0
	totalCost := 0.0
	for _, execution := range executions {
		if execution.StartedAt.UTC().Format("2006-01-02") == today {
			runsToday++
		}
		if execution.Status == models.StatusDone {
			succeeded++
			finished++
		} else if execution.Status == models.StatusFailed {
			finished++
		}
		if execution.CompletedAt != nil {
			totalLatency += execution.DurationMS
			latencySamples++
		}
		totalCost += execution.CostUSD
	}
	successRate := percentage(succeeded, finished)
	healed := 0
	for _, report := range reports {
		if healingSucceeded(report.Status) {
			healed++
		}
	}
	avgLatency := int64(0)
	if latencySamples > 0 {
		avgLatency = totalLatency / int64(latencySamples)
	}
	return c.JSON(models.OK(map[string]interface{}{
		"runsToday": runsToday, "avgLatencyMs": avgLatency, "tokenCostUsd": totalCost,
		"projectedMonthlyCostUsd": 0, "successRate": successRate,
		"healingSuccessRate": percentage(healed, len(reports)),
		"validationF1Score":  nil, "validationMetricsAvailable": false,
	}, "OK", map[string]interface{}{"range": c.Query("range", "7d")}))
}

func (h *Handler) AnalyticsPerformance(c *fiber.Ctx) error {
	executions, _ := h.analyticsSnapshot()
	days := executionDays(executions, 7)
	out := make([]map[string]interface{}, 0, len(days))
	for _, day := range days {
		latencies := make([]int64, 0, len(day.Executions))
		succeeded := 0
		finished := 0
		var totalLatency int64
		for _, execution := range day.Executions {
			if execution.Status == models.StatusDone {
				succeeded++
				finished++
			} else if execution.Status == models.StatusFailed {
				finished++
			}
			if execution.CompletedAt != nil {
				latencies = append(latencies, execution.DurationMS)
				totalLatency += execution.DurationMS
			}
		}
		avg := int64(0)
		if len(latencies) > 0 {
			avg = totalLatency / int64(len(latencies))
		}
		out = append(out, map[string]interface{}{
			"label": day.Label, "runs": len(day.Executions), "successRate": percentage(succeeded, finished),
			"avgLatencyMs": avg, "p95LatencyMs": percentile95(latencies),
		})
	}
	return c.JSON(models.OK(out, "OK", map[string]interface{}{"interval": "day"}))
}

func (h *Handler) AnalyticsUsage(c *fiber.Ctx) error {
	executions, _ := h.analyticsSnapshot()
	days := executionDays(executions, 7)
	out := make([]map[string]interface{}, 0, len(days))
	for _, day := range days {
		input, output := 0, 0
		cost := 0.0
		for _, execution := range day.Executions {
			input += execution.Tokens.Input
			output += execution.Tokens.Output
			cost += execution.CostUSD
		}
		out = append(out, map[string]interface{}{"label": day.Label, "inputTokens": input, "outputTokens": output, "totalTokens": input + output, "costUsd": cost})
	}
	return c.JSON(models.OK(out, "OK", map[string]interface{}{"currency": "USD"}))
}

func (h *Handler) AnalyticsSelfHealing(c *fiber.Ctx) error {
	_, reports := h.analyticsSnapshot()
	recovered := 0
	byReason := map[string]map[string]int{}
	for _, report := range reports {
		success := healingSucceeded(report.Status)
		if success {
			recovered++
		}
		reason := "unspecified"
		if len(report.Events) > 0 {
			if value := strings.TrimSpace(toString(report.Events[0]["type"])); value != "" {
				reason = value
			}
		}
		if byReason[reason] == nil {
			byReason[reason] = map[string]int{"attempts": 0, "recovered": 0}
		}
		byReason[reason]["attempts"]++
		if success {
			byReason[reason]["recovered"]++
		}
	}
	reasons := make([]map[string]interface{}, 0, len(byReason))
	for reason, counts := range byReason {
		reasons = append(reasons, map[string]interface{}{"reason": reason, "attempts": counts["attempts"], "recovered": counts["recovered"]})
	}
	sort.Slice(reasons, func(i, j int) bool { return toString(reasons[i]["reason"]) < toString(reasons[j]["reason"]) })
	return c.JSON(models.OK(map[string]interface{}{
		"successRate": percentage(recovered, len(reports)), "attempts": len(reports),
		"recovered": recovered, "failed": len(reports) - recovered, "byReason": reasons,
	}, "OK", nil))
}

func (h *Handler) AnalyticsLatency(c *fiber.Ctx) error {
	executions, _ := h.analyticsSnapshot()
	buckets := []struct {
		label string
		min   int64
		max   int64
	}{{"0-500ms", 0, 500}, {"500ms-1s", 500, 1000}, {"1s-2s", 1000, 2000}, {"2s-5s", 2000, 5000}, {"5s+", 5000, 1 << 62}}
	out := make([]map[string]interface{}, 0, len(buckets))
	for _, bucket := range buckets {
		count := 0
		for _, execution := range executions {
			if execution.CompletedAt != nil && execution.DurationMS >= bucket.min && execution.DurationMS < bucket.max {
				count++
			}
		}
		out = append(out, map[string]interface{}{"bucket": bucket.label, "count": count})
	}
	return c.JSON(models.OK(out, "OK", nil))
}

func (h *Handler) AnalyticsF1Score(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]interface{}{
		"available": false, "score": nil, "precision": nil, "recall": nil,
		"samples": 0, "falsePositives": 0, "falseNegatives": 0,
	}, "No runtime validation benchmark has been recorded", nil))
}

func (h *Handler) AnalyticsActivityHeatmap(c *fiber.Ctx) error {
	executions, _ := h.analyticsSnapshot()
	days := executionDays(executions, 14)
	maxCount := 0
	for _, day := range days {
		if len(day.Executions) > maxCount {
			maxCount = len(day.Executions)
		}
	}
	out := make([]map[string]interface{}, 0, len(days))
	for _, day := range days {
		intensity := 0.0
		if maxCount > 0 {
			intensity = float64(len(day.Executions)) / float64(maxCount)
		}
		out = append(out, map[string]interface{}{"date": day.Label, "count": len(day.Executions), "intensity": intensity})
	}
	return c.JSON(models.OK(out, "OK", map[string]interface{}{"timezone": "UTC"}))
}

func (h *Handler) AnalyticsCostTrends(c *fiber.Ctx) error {
	executions, _ := h.analyticsSnapshot()
	days := executionDays(executions, 7)
	out := make([]map[string]interface{}, 0, len(days))
	for _, day := range days {
		cost := 0.0
		for _, execution := range day.Executions {
			cost += execution.CostUSD
		}
		out = append(out, map[string]interface{}{"label": day.Label, "costUsd": cost})
	}
	return c.JSON(models.OK(out, "OK", map[string]interface{}{"interval": "day"}))
}

type executionDay struct {
	Label      string
	Executions []models.Execution
}

func (h *Handler) analyticsSnapshot() ([]models.Execution, []models.HealingReport) {
	h.Store.Mu.RLock()
	defer h.Store.Mu.RUnlock()
	executions := make([]models.Execution, 0, len(h.Store.Executions))
	for _, execution := range h.Store.Executions {
		executions = append(executions, *execution)
	}
	reports := make([]models.HealingReport, 0, len(h.Store.Healing))
	for _, report := range h.Store.Healing {
		reports = append(reports, report)
	}
	return executions, reports
}

func executionDays(executions []models.Execution, count int) []executionDay {
	today := time.Now().UTC()
	days := make([]executionDay, count)
	indexByDate := make(map[string]int, count)
	for index := 0; index < count; index++ {
		date := today.AddDate(0, 0, index-count+1).Format("2006-01-02")
		days[index] = executionDay{Label: date, Executions: []models.Execution{}}
		indexByDate[date] = index
	}
	for _, execution := range executions {
		date := execution.StartedAt.UTC().Format("2006-01-02")
		if index, ok := indexByDate[date]; ok {
			days[index].Executions = append(days[index].Executions, execution)
		}
	}
	return days
}

func percentage(part, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(part) / float64(total) * 100
}

func percentile95(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	index := (95*len(values) + 99) / 100
	if index < 1 {
		index = 1
	}
	return values[index-1]
}

func healingSucceeded(status string) bool {
	return strings.EqualFold(status, "repaired") || strings.EqualFold(status, "recovered")
}

func toString(value interface{}) string {
	text, _ := value.(string)
	return text
}
