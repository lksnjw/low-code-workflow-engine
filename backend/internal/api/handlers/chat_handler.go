package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) Synthesize(c *fiber.Ctx) error {
	body := decodeMap(c)
	prompt, _ := body["prompt"].(string)
	if prompt == "" {
		return fiber.NewError(fiber.StatusBadRequest, "prompt is required")
	}
	mode, _ := body["mode"].(string)
	model, _ := body["model"].(string)
	contextMap, _ := body["context"].(map[string]interface{})

	result, err := h.Synth.Synthesize(c.Context(), prompt, mode, model, contextMap)
	if err != nil {
		return fiber.NewError(fiber.StatusBadGateway, err.Error())
	}
	validation, blueprint := h.Validator.ValidateYAML(result.YAML, h.permissions(c))

	response := map[string]interface{}{
		"yaml":       result.YAML,
		"confidence": result.Confidence,
		"workflowDraft": map[string]interface{}{
			"name":    blueprint.Name,
			"steps":   len(blueprint.Steps),
			"trigger": blueprint.Trigger.Type,
		},
		"validation":  validation,
		"flowPreview": previewCanvas("draft", blueprint),
		"usage":       result.Usage,
	}

	return c.JSON(models.OK(response, "Workflow draft generated", nil))
}

func (h *Handler) SynthesisValidate(c *fiber.Ctx) error {
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	_, validation, err := h.validateWithFullGate(c, "SynthesisValidate", yamlText)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.JSON(models.OK(validation, registryValidationMessage(validation), nil))
}

func (h *Handler) SynthesisPreviewFlow(c *fiber.Ctx) error {
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	validation, blueprint := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Cannot preview invalid YAML", validation))
	}
	return c.JSON(models.OK(previewCanvas("preview", blueprint), "Flow preview generated", nil))
}

func (h *Handler) SynthesisExplain(c *fiber.Ctx) error {
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	validation, blueprint := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Cannot explain invalid YAML", validation))
	}
	steps := make([]map[string]interface{}, 0, len(blueprint.Steps))
	for _, step := range blueprint.Steps {
		steps = append(steps, map[string]interface{}{"id": step.ID, "action": step.Action, "purpose": "Executes through the tool registry and MCP bridge."})
	}
	return c.JSON(models.OK(map[string]interface{}{"summary": "This workflow starts from " + blueprint.Trigger.Type + " and executes each validated MCP-safe step sequentially.", "steps": steps}, "Explanation generated", nil))
}

func (h *Handler) ListChatSessions(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	user := h.currentUser(c)
	h.Store.Mu.RLock()
	sessions := make([]models.ChatSession, 0, len(h.Store.Chats))
	for _, session := range h.Store.Chats {
		if canAccessChatSession(user, session) {
			sessions = append(sessions, session.ChatSession)
		}
	}
	h.Store.Mu.RUnlock()
	paged, meta := paginate(sessions, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) CreateChatSession(c *fiber.Ctx) error {
	body := decodeMap(c)
	title := fmt.Sprint(body["title"])
	if title == "" || title == "<nil>" {
		title = "New workflow conversation"
	}
	now := time.Now().UTC()
	session := &models.ChatSessionDetail{ChatSession: models.ChatSession{ID: "chat_" + randomHex(4), OwnerID: h.currentUserID(c), Title: title, CreatedAt: now, UpdatedAt: now, MessageCount: 0}, Messages: []models.ChatMessage{}}
	h.Store.Mu.Lock()
	h.Store.Chats[session.ID] = session
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(session.ChatSession, "Chat session created", nil))
}

func (h *Handler) GetChatSession(c *fiber.Ctx) error {
	user := h.currentUser(c)
	h.Store.Mu.RLock()
	session, ok := h.Store.Chats[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok || !canAccessChatSession(user, session) {
		return fiber.NewError(fiber.StatusNotFound, "Chat session not found")
	}
	return c.JSON(models.OK(session, "OK", nil))
}

func (h *Handler) UpdateChatSession(c *fiber.Ctx) error {
	body := decodeMap(c)
	user := h.currentUser(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	session, ok := h.Store.Chats[c.Params("id")]
	if !ok || !canAccessChatSession(user, session) {
		return fiber.NewError(fiber.StatusNotFound, "Chat session not found")
	}
	if title := fmt.Sprint(body["title"]); title != "" && title != "<nil>" {
		session.Title = title
	}
	session.UpdatedAt = time.Now().UTC()
	return c.JSON(models.OK(session.ChatSession, "Chat session updated", nil))
}

func (h *Handler) DeleteChatSession(c *fiber.Ctx) error {
	user := h.currentUser(c)
	h.Store.Mu.Lock()
	session, ok := h.Store.Chats[c.Params("id")]
	if !ok || !canAccessChatSession(user, session) {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusNotFound, "Chat session not found")
	}
	delete(h.Store.Chats, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Chat session deleted", nil))
}

func (h *Handler) SendChatMessage(c *fiber.Ctx) error {
	body := decodeMap(c)
	message := fmt.Sprint(body["content"])
	if message == "" || message == "<nil>" {
		message = fmt.Sprint(body["message"])
	}
	if message == "" || message == "<nil>" {
		return fiber.NewError(fiber.StatusBadRequest, "message is required")
	}
	model, _ := body["model"].(string)
	mode, _ := body["mode"].(string)

	now := time.Now().UTC()
	user := h.currentUser(c)
	userMessage := models.ChatMessage{ID: "msg_" + randomHex(4), Role: "user", Text: message, CreatedAt: now}

	h.Store.Mu.Lock()
	session, ok := h.Store.Chats[c.Params("id")]
	if !ok {
		session = &models.ChatSessionDetail{ChatSession: models.ChatSession{ID: c.Params("id"), OwnerID: h.currentUserID(c), Title: "Workflow conversation", CreatedAt: now}, Messages: []models.ChatMessage{}}
		h.Store.Chats[session.ID] = session
	} else if !canAccessChatSession(user, session) {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusNotFound, "Chat session not found")
	}
	session.Messages = append(session.Messages, userMessage)
	h.Store.Mu.Unlock()

	if h.Orchestrator == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "chat orchestration is not configured")
	}

	userRole := "anonymous"
	if user != nil {
		userRole = user.Role.Name
	}
	if h.Cfg.ChatUserRoleOverride != "" {
		userRole = h.Cfg.ChatUserRoleOverride
	}
	generateCount := toInt(body["generate_candidates"], h.Cfg.CandidateCount)
	if generateCount <= 0 {
		generateCount = h.Cfg.CandidateCount
	}
	dryRun, _ := body["dry_run"].(bool)
	chatReq := orchestrator.ChatRequest{
		SessionID:     c.Params("id"),
		UserText:      message,
		UserRole:      userRole,
		Mode:          mode,
		Model:         model,
		TopKTools:     toInt(body["top_k_tools"], h.Cfg.SemanticSearchTopKTools),
		TopKRules:     toInt(body["top_k_rules"], h.Cfg.SemanticSearchTopKRules),
		TopKTemplates: toInt(body["top_k_templates"], h.Cfg.SemanticSearchTopKTemplates),
		TopKExamples:  toInt(body["top_k_examples"], h.Cfg.SemanticSearchTopKExamples),
		GenerateCount: generateCount,
		DryRun:        dryRun,
	}
	started := time.Now()
	response, err := h.Orchestrator.HandleChatMessage(c.Context(), chatReq)
	elapsed := time.Since(started)
	if err != nil {
		if h.Cfg.ChatTraceBoxes {
			fmt.Print(orchestrator.RenderTerminalError(chatReq, elapsed, err))
		}
		return fiber.NewError(fiber.StatusBadGateway, "workflow orchestration failed: "+err.Error())
	}
	if h.Cfg.ChatTraceBoxes {
		fmt.Print(orchestrator.RenderTerminalTrace(chatReq, response, elapsed))
	}

	artifacts := map[string]interface{}{
		"retrieval":              response.Retrieval,
		"candidates":             response.Candidates,
		"selected_candidate_id":  response.SelectedCandidateID,
		"selected_workflow_yaml": response.SelectedWorkflowYAML,
		"can_execute":            response.CanExecute,
		"validation_summary":     response.ValidationSummary,
		"blocking_errors":        response.BlockingErrors,
		"next_action":            response.NextAction,
	}
	assistantMessage := models.ChatMessage{ID: "msg_" + randomHex(4), Role: "assistant", Text: response.AssistantMessage, Artifacts: artifacts, CreatedAt: now.Add(2 * time.Second)}

	h.Store.Mu.Lock()
	session.Messages = append(session.Messages, assistantMessage)
	session.MessageCount = len(session.Messages)
	session.UpdatedAt = now
	h.Store.Mu.Unlock()

	return c.JSON(models.OK(map[string]interface{}{
		"userMessage":            userMessage,
		"assistantMessage":       assistantMessage,
		"session_id":             response.SessionID,
		"assistant_message":      response.AssistantMessage,
		"retrieval":              response.Retrieval,
		"candidates":             response.Candidates,
		"selected_candidate_id":  response.SelectedCandidateID,
		"selected_workflow_yaml": response.SelectedWorkflowYAML,
		"can_execute":            response.CanExecute,
		"validation_summary":     response.ValidationSummary,
		"blocking_errors":        response.BlockingErrors,
		"next_action":            response.NextAction,
	}, "Message processed", nil))
}
