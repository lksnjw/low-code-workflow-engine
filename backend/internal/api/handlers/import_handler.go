package handlers

import (
	"encoding/json"
	"io"
	"sort"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/importer"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

type importCommitRequest struct {
	AnalysisID       string   `json:"analysisId"`
	SelectedRecordID []string `json:"selectedRecordIds"`
}

func (h *Handler) AnalyseRegistryImport(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.Importer == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry import service is not configured")
	}
	header, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Choose a registry file to analyse")
	}
	if header.Size > importer.MaxUploadBytes {
		return fiber.NewError(fiber.StatusRequestEntityTooLarge, "The uploaded file exceeds the 10 MiB limit")
	}
	file, err := header.Open()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "The uploaded file could not be opened")
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, importer.MaxUploadBytes+1))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "The uploaded file could not be read")
	}
	if len(content) > importer.MaxUploadBytes {
		return fiber.NewError(fiber.StatusRequestEntityTooLarge, "The uploaded file exceeds the 10 MiB limit")
	}
	allowUpdates, _ := strconv.ParseBool(c.FormValue("allowUpdates", "false"))
	analysis, err := h.Importer.Analyse(importer.AnalyseInput{
		Filename: header.Filename, Content: content, Kind: importer.SourceKind(c.FormValue("kind")),
		Prefix: c.FormValue("prefix"), AllowUpdates: allowUpdates,
	})
	if err != nil {
		return fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
	}
	return c.JSON(models.OK(analysis, "Import analysis completed; no registry data was persisted", nil))
}

func (h *Handler) CommitRegistryImport(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.Importer == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry import service is not configured")
	}
	var request importCommitRequest
	if err := h.parseBody(c, &request); err != nil {
		return err
	}
	if request.AnalysisID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "analysisId is required")
	}
	user := h.currentUser(c)
	result, err := h.Importer.Commit(request.AnalysisID, importer.CommitOptions{
		SelectedRecordIDs: request.SelectedRecordID,
		ActorID:           user.ID,
		ActorName:         user.Name,
	})
	if err != nil {
		return fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
	}
	history := h.Importer.History()
	var historyEntry importer.HistoryEntry
	if len(history) > 0 {
		historyEntry = history[0]
	}
	h.Store.Mu.Lock()
	h.Store.Audit(
		principalFromUser(user),
		"registry.import.committed",
		models.ResourceRef{Type: "registry_import", ID: result.AnalysisID},
		nil,
		map[string]interface{}{
			"filename": result.Filename, "fileSha256": result.FileSHA256,
			"counts": result.Counts, "resultingRegistryHash": result.ResultingHash,
			"committedRecordIds": result.CommittedRecordID, "history": historyEntry,
		},
		c.IP(),
		c.Get("User-Agent"),
	)
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(result, "Registry import committed", nil))
}

func (h *Handler) RegistryImportHistory(c *fiber.Ctx) error {
	if err := h.requireRegistryWrite(c); err != nil {
		return err
	}
	if h.Importer == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "registry import service is not configured")
	}
	history := h.Importer.History()
	seen := map[string]bool{}
	for _, entry := range history {
		seen[entry.AnalysisID] = true
	}
	h.Store.Mu.RLock()
	for _, audit := range h.Store.AuditLogs {
		if audit == nil || audit.Action != "registry.import.committed" || audit.After == nil {
			continue
		}
		raw, err := json.Marshal(audit.After["history"])
		if err != nil {
			continue
		}
		var entry importer.HistoryEntry
		if json.Unmarshal(raw, &entry) != nil || entry.AnalysisID == "" || seen[entry.AnalysisID] {
			continue
		}
		history = append(history, entry)
		seen[entry.AnalysisID] = true
	}
	h.Store.Mu.RUnlock()
	sort.Slice(history, func(i, j int) bool { return history[i].CommittedAt.After(history[j].CommittedAt) })
	return c.JSON(models.OK(history, "Registry import history loaded", map[string]interface{}{"count": len(history)}))
}
