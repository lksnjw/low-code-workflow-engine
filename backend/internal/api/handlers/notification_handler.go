package handlers

import (
	"fmt"
	"io"
	"mime/multipart"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/relevance"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

func (h *Handler) ListNotifications(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	unreadOnly := c.QueryBool("unreadOnly", false)
	h.Store.Mu.RLock()
	all := repository.ListMapValues(h.Store.Notifications)
	h.Store.Mu.RUnlock()
	items := []models.Notification{}
	for _, notification := range all {
		if unreadOnly && notification.Read {
			continue
		}
		items = append(items, notification)
	}
	paged, meta := paginate(items, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) MarkNotificationRead(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	notification, ok := h.Store.Notifications[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Notification not found")
	}
	notification.Read = true
	return c.JSON(models.OK(notification, "Notification marked read", nil))
}

func (h *Handler) MarkAllNotificationsRead(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	for _, notification := range h.Store.Notifications {
		notification.Read = true
	}
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"updated": true}, "All notifications marked read", nil))
}

func (h *Handler) DeleteNotification(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Notifications, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Notification deleted", nil))
}

func (h *Handler) Upload(c *fiber.Ctx) error {
	file, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "file is required")
	}
	stream, err := file.Open()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "could not open uploaded file")
	}
	defer stream.Close()
	contents, err := io.ReadAll(stream)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "could not read uploaded file")
	}
	uploaded := uploadedFromFile(file, contents)
	h.Store.Mu.Lock()
	h.Store.Uploads[uploaded.ID] = &uploaded
	h.Store.UploadContents[uploaded.ID] = contents
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(uploaded, "Upload complete", nil))
}

func (h *Handler) DownloadUpload(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	file, ok := h.Store.Uploads[c.Params("id")]
	contents := append([]byte(nil), h.Store.UploadContents[c.Params("id")]...)
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Upload not found")
	}
	c.Set(fiber.HeaderContentType, file.MimeType)
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf("attachment; filename=%q", file.Name))
	return c.Send(contents)
}

func (h *Handler) GetUpload(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	file, ok := h.Store.Uploads[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Upload not found")
	}
	return c.JSON(models.OK(file, "OK", nil))
}

func (h *Handler) DeleteUpload(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Uploads, c.Params("id"))
	delete(h.Store.UploadContents, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Upload deleted", nil))
}

func (h *Handler) ImportWorkflow(c *fiber.Ctx) error {
	yamlText := c.FormValue("yaml")
	if yamlText == "" {
		body := decodeMap(c)
		yamlText, _ = body["yaml"].(string)
	}
	if yamlText == "" {
		return fiber.NewError(fiber.StatusBadRequest, "yaml is required")
	}

	validation, blueprint := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow YAML failed validation", validation))
	}
	_, fullValidation, err := h.validateWithFullGate(c, "ImportWorkflow", yamlText)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if !fullValidation.Passed {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation", fullValidation))
	}
	domainTags, err := relevance.DomainTagsFromBlueprint(blueprint, h.activeRegistryTools())
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "derive imported workflow domains", "The workflow domains could not be derived from the active registry. Try again.", err)
	}
	now := time.Now().UTC()
	id := "wf-" + randomHex(4)
	workflow := &models.Workflow{ID: id, Name: blueprint.Name, Description: blueprint.Description, Owner: principalFromUser(h.currentUser(c)), Status: models.StatusPending, Trigger: map[string]interface{}{"type": blueprint.Trigger.Type, "displayName": blueprint.Trigger.DisplayName, "config": blueprint.Trigger.Config}, Steps: len(blueprint.Steps), DraftVersion: 1, DomainTags: domainTags, YAML: yamlText, Canvas: previewCanvas(id, blueprint), CreatedAt: now, UpdatedAt: now}
	if workflow.Name == "" {
		workflow.Name = "Imported Workflow"
	}
	actor := principalFromUser(h.currentUser(c))
	h.Store.Mu.Lock()
	h.Store.Workflows[id] = workflow
	h.Store.Audit(actor, "workflow.imported", models.ResourceRef{Type: "workflow", ID: id}, nil, map[string]interface{}{"name": workflow.Name}, c.IP(), c.Get("User-Agent"))
	h.Store.Mu.Unlock()

	return c.JSON(models.OK(map[string]interface{}{"workflow": map[string]interface{}{"id": workflow.ID, "name": workflow.Name, "status": workflow.Status}, "validation": validation}, "Workflow imported", nil))
}

func uploadedFromFile(file *multipart.FileHeader, contents []byte) models.UploadedFile {
	id := "file_" + randomHex(4)
	return models.UploadedFile{
		ID:        id,
		Name:      file.Filename,
		MimeType:  file.Header.Get("Content-Type"),
		SizeBytes: file.Size,
		URL:       "/api/upload/" + id + "/download",
		Checksum:  parser.Checksum(string(contents)),
		CreatedAt: time.Now().UTC(),
	}
}
