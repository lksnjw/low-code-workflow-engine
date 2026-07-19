package handlers

import (
	"strings"
	"time"

	"github.com/gofiber/contrib/websocket"
)

func (h *Handler) WebSocketEvents(conn *websocket.Conn) {
	defer conn.Close()
	channel := conn.Params("*")
	if channel == "" {
		channel = "system-health"
	}

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if err := conn.WriteJSON(h.runtimeEvent(channel)); err != nil {
			return
		}
		<-ticker.C
	}
}

func (h *Handler) runtimeEvent(channel string) map[string]interface{} {
	h.Store.Mu.RLock()
	workflowCount := len(h.Store.Workflows)
	executionCount := len(h.Store.Executions)
	runningCount := 0
	for _, execution := range h.Store.Executions {
		if execution.Status == "RUNNING" {
			runningCount++
		}
	}
	h.Store.Mu.RUnlock()

	mcpConfigured := strings.TrimSpace(h.Cfg.MCPBaseURL) != ""
	overall := "healthy"
	if !mcpConfigured {
		overall = "degraded"
	}
	return map[string]interface{}{
		"type": "system.health.snapshot", "id": "evt_" + randomHex(4), "timestamp": time.Now().UTC(),
		"data": map[string]interface{}{
			"channel": channel, "overall": overall, "workflows": workflowCount,
			"executions": executionCount, "runningExecutions": runningCount, "mcpConfigured": mcpConfigured,
		},
	}
}
