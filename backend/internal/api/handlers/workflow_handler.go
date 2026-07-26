package handlers

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/relevance"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

func (h *Handler) ListWorkflows(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	user := h.currentUser(c)
	relevanceMode := strings.ToLower(strings.TrimSpace(c.Query("relevance")))
	if relevanceMode == "" {
		if userHasPermission(user, "workflow_view_all") {
			relevanceMode = "all"
		} else {
			relevanceMode = "relevant"
		}
	}
	if relevanceMode != "relevant" && relevanceMode != "all" {
		return fiber.NewError(fiber.StatusBadRequest, "relevance must be relevant or all")
	}
	if relevanceMode == "all" && !userHasPermission(user, "workflow:read") {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Listing all workflows requires workflow:read", nil))
	}
	tools := h.activeRegistryTools()
	h.Store.Mu.RLock()
	profile, profileErr := h.companyProfileLocked()
	if profileErr != nil {
		h.Store.Mu.RUnlock()
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	items := make([]models.Workflow, 0, len(h.Store.Workflows))
	for _, workflow := range h.Store.Workflows {
		if !canReadWorkflow(user, workflow) {
			continue
		}
		evaluation := relevance.Evaluate(user, workflow, profile, tools)
		if relevanceMode == "relevant" && !evaluation.Relevant {
			continue
		}
		item := *workflow
		item.DomainTags = append([]string(nil), workflow.DomainTags...)
		item.CanRun = evaluation.CanRun
		items = append(items, item)
	}
	h.Store.Mu.RUnlock()

	items = repository.FilterWorkflows(items, c.Query("q"), c.Query("status"))
	repository.SortWorkflows(items)
	paged, meta := paginate(items, page, limit)
	meta.Sort = c.Query("sort", "-updatedAt")
	return c.JSON(models.OK(paged, "OK", map[string]interface{}{
		"page": meta.Page, "limit": meta.Limit, "total": meta.Total, "totalPages": meta.TotalPages,
		"sort": meta.Sort, "relevance": relevanceMode,
	}))
}

func (h *Handler) CreateWorkflow(c *fiber.Ctx) error {
	var req models.CreateWorkflowRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	actor := principalFromUser(h.currentUser(c))

	if req.YAML == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Workflow YAML is required")
	}
	validation, blueprint := h.Validator.ValidateYAML(req.YAML, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow YAML failed validation", validation))
	}
	_, fullValidation, err := h.validateWithFullGate(c, "CreateWorkflow", req.YAML)
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "validate workflow before creation", "The workflow could not be checked against the registry before creation. Try again.", err)
	}
	if !fullValidation.Passed {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation", fullValidation))
	}
	domainTags, err := relevance.DomainTagsFromBlueprint(blueprint, h.activeRegistryTools())
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "derive workflow domains before creation", "The workflow domains could not be derived from the active registry. Try again.", err)
	}

	now := time.Now().UTC()
	id := "wf-" + randomHex(4)
	workflow := &models.Workflow{
		ID: id, Name: req.Name, Description: req.Description,
		Owner: actor, Status: models.StatusPending,
		Trigger: req.Trigger, Steps: len(blueprint.Steps), SuccessRate: 0, PublishedVersion: 0, DraftVersion: 1,
		Tags: req.Tags, DomainTags: domainTags, YAML: req.YAML, Canvas: previewCanvas(id, blueprint), CreatedAt: now, UpdatedAt: now,
	}
	if workflow.Name == "" {
		workflow.Name = blueprint.Name
	}
	if workflow.Description == "" {
		workflow.Description = blueprint.Description
	}
	if workflow.Trigger == nil {
		workflow.Trigger = map[string]interface{}{"type": blueprint.Trigger.Type, "displayName": blueprint.Trigger.DisplayName, "config": blueprint.Trigger.Config}
	}

	h.Store.Mu.Lock()
	h.Store.Workflows[id] = workflow
	h.Store.Audit(actor, "workflow.created", models.ResourceRef{Type: "workflow", ID: id}, nil, map[string]interface{}{"name": workflow.Name}, c.IP(), c.Get("User-Agent"))
	h.Store.Mu.Unlock()

	return c.Status(fiber.StatusCreated).JSON(models.OK(workflow, "Workflow created", nil))
}

func (h *Handler) GetWorkflow(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok || !canReadWorkflow(h.currentUser(c), workflow) {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	return c.JSON(models.OK(workflow, "OK", nil))
}

func (h *Handler) UpdateWorkflow(c *fiber.Ctx) error {
	var req models.UpdateWorkflowRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	actor := principalFromUser(h.currentUser(c))

	stored, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	token, fullValidation, err := h.validateWithFullGate(c, "UpdateWorkflow", stored.YAML)
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "validate workflow before update", "The workflow could not be checked against the registry before updating. Try again.", err)
	}
	if !fullValidation.Passed {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation", fullValidation))
	}

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	if workflowvalidator.WorkflowContentHash(workflow.YAML) != token.WorkflowContentHash {
		return fiber.NewError(fiber.StatusConflict, "Workflow changed during validation; retry the update")
	}
	before := map[string]interface{}{"name": workflow.Name, "status": workflow.Status}
	if req.Name != nil {
		workflow.Name = *req.Name
	}
	if req.Description != nil {
		workflow.Description = *req.Description
	}
	if req.Status != nil {
		workflow.Status = *req.Status
	}
	if req.Trigger != nil {
		workflow.Trigger = req.Trigger
	}
	if req.Tags != nil {
		workflow.Tags = req.Tags
	}
	workflow.UpdatedAt = time.Now().UTC()
	h.Store.Audit(actor, "workflow.updated", models.ResourceRef{Type: "workflow", ID: workflow.ID}, before, map[string]interface{}{"name": workflow.Name, "status": workflow.Status}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(workflow, "Workflow updated", nil))
}

func (h *Handler) DeleteWorkflow(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	if _, ok := h.Store.Workflows[c.Params("id")]; !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	delete(h.Store.Workflows, c.Params("id"))
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Workflow deleted", nil))
}

func (h *Handler) DuplicateWorkflow(c *fiber.Ctx) error {
	body := decodeMap(c)
	source, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}

	clone := *source
	clone.ID = "wf-" + randomHex(4)
	clone.Name = fmt.Sprint(body["name"])
	if clone.Name == "" || clone.Name == "<nil>" {
		clone.Name = source.Name + " Copy"
	}
	clone.Status = models.StatusPending
	clone.CreatedAt = time.Now().UTC()
	clone.UpdatedAt = clone.CreatedAt
	clone.Canvas.WorkflowID = clone.ID

	h.Store.Mu.Lock()
	h.Store.Workflows[clone.ID] = &clone
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(clone, "Workflow duplicated", nil))
}

func (h *Handler) PublishWorkflow(c *fiber.Ctx) error {
	body := decodeMap(c)
	actor := principalFromUser(h.currentUser(c))
	stored, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	token, fullValidation, err := h.validateWithFullGate(c, "PublishWorkflow", stored.YAML)
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "validate workflow before publishing", "The workflow could not be checked against the registry before publishing. Try again.", err)
	}
	if !fullValidation.Passed {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation", fullValidation))
	}
	domainTags, err := relevance.DomainTagsFromYAML(stored.YAML, h.activeRegistryTools())
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "derive workflow domains before publishing", "The workflow domains could not be derived from the active registry. Try again.", err)
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	if workflowvalidator.WorkflowContentHash(workflow.YAML) != token.WorkflowContentHash {
		return fiber.NewError(fiber.StatusConflict, "Workflow changed during validation; retry publishing")
	}
	if workflow.Status == models.StatusDraftUnvalidated {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow canvas has unvalidated execution changes", map[string]interface{}{"status": workflow.Status}))
	}
	workflow.DomainTags = domainTags
	workflow.PublishedVersion = workflow.DraftVersion
	version := models.WorkflowVersion{
		ID: "ver_" + randomHex(4), WorkflowID: workflow.ID, Version: workflow.PublishedVersion,
		VersionNote: fmt.Sprint(body["versionNote"]), YAML: workflow.YAML, CreatedAt: time.Now().UTC(), CreatedBy: actor,
	}
	h.Store.Versions[workflow.ID] = append(h.Store.Versions[workflow.ID], version)
	return c.JSON(models.OK(version, "Workflow published", nil))
}

func (h *Handler) ArchiveWorkflow(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	workflow.Archived = true
	workflow.Status = models.StatusDone
	return c.JSON(models.OK(map[string]bool{"archived": true}, "Workflow archived", nil))
}

func (h *Handler) ValidateWorkflow(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	if yamlText == "" {
		yamlText = workflow.YAML
	}
	_, validation, err := h.validateWithFullGate(c, "ValidateWorkflow", yamlText)
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "validate workflow", "The workflow could not be checked against the registry. Try validation again.", err)
	}
	return c.JSON(models.OK(validation, registryValidationMessage(validation), nil))
}

func (h *Handler) GetWorkflowYAML(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok || !canReadWorkflow(h.currentUser(c), workflow) {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	return c.JSON(models.OK(models.WorkflowYAML{WorkflowID: workflow.ID, Version: workflow.DraftVersion, YAML: workflow.YAML, Checksum: parser.Checksum(workflow.YAML), UpdatedAt: workflow.UpdatedAt}, "OK", nil))
}

func (h *Handler) PutWorkflowYAML(c *fiber.Ctx) error {
	var req models.WorkflowYAML
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	validation, blueprint := h.Validator.ValidateYAML(req.YAML, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow YAML failed validation", validation))
	}
	_, fullValidation, err := h.validateWithFullGate(c, "PutWorkflowYAML", req.YAML)
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "validate workflow YAML before update", "The workflow YAML could not be checked against the registry before saving. Try again.", err)
	}
	if !fullValidation.Passed {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow failed full registry validation", fullValidation))
	}
	domainTags, err := relevance.DomainTagsFromBlueprint(blueprint, h.activeRegistryTools())
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "derive workflow domains before YAML update", "The workflow domains could not be derived from the active registry. Try again.", err)
	}

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	workflow.YAML = req.YAML
	workflow.DraftVersion++
	workflow.Steps = len(blueprint.Steps)
	workflow.DomainTags = domainTags
	workflow.Canvas = previewCanvas(workflow.ID, blueprint)
	if workflow.Status == models.StatusDraftUnvalidated {
		workflow.Status = models.StatusPending
	}
	workflow.UpdatedAt = time.Now().UTC()
	return c.JSON(models.OK(models.WorkflowYAML{WorkflowID: workflow.ID, Version: workflow.DraftVersion, YAML: workflow.YAML, Checksum: parser.Checksum(workflow.YAML), UpdatedAt: workflow.UpdatedAt}, "Workflow YAML updated", nil))
}

func (h *Handler) GetWorkflowCanvas(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok || !canReadWorkflow(h.currentUser(c), workflow) {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	return c.JSON(models.OK(workflow.Canvas, "OK", nil))
}

func (h *Handler) PutWorkflowCanvas(c *fiber.Ctx) error {
	var canvas models.WorkflowCanvas
	if err := h.parseBody(c, &canvas); err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	canvas.WorkflowID = workflow.ID
	if canvasExecutionSemanticsChanged(workflow.Canvas, canvas) {
		workflow.Status = models.StatusDraftUnvalidated
	}
	workflow.Canvas = canvas
	workflow.UpdatedAt = time.Now().UTC()
	return c.JSON(models.OK(canvas, "Workflow canvas updated", nil))
}

func (h *Handler) WorkflowVersions(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok || !canReadWorkflow(h.currentUser(c), workflow) {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	h.Store.Mu.RLock()
	versions := append([]models.WorkflowVersion{}, h.Store.Versions[c.Params("id")]...)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(versions, "OK", nil))
}

func (h *Handler) ListAssignableWorkflowUsers(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	users := make([]map[string]interface{}, 0, len(h.Store.Users))
	for userID := range h.Store.Users {
		user, ok := h.Store.EffectiveUserLocked(userID)
		if !ok {
			continue
		}
		if !strings.EqualFold(user.Status, "active") {
			continue
		}
		users = append(users, map[string]interface{}{
			"id": user.ID, "name": user.Name, "email": user.Email, "role": user.Role.Name,
		})
	}
	h.Store.Mu.RUnlock()
	sort.Slice(users, func(i, j int) bool { return fmt.Sprint(users[i]["name"]) < fmt.Sprint(users[j]["name"]) })
	return c.JSON(models.OK(users, "Assignable users loaded", map[string]interface{}{"count": len(users)}))
}

func (h *Handler) AssignWorkflowUser(c *fiber.Ctx) error {
	body := decodeMap(c)
	userID := fmt.Sprint(body["userId"])
	if userID == "" || userID == "<nil>" {
		return fiber.NewError(fiber.StatusBadRequest, "userId is required")
	}
	actor := principalFromUser(h.currentUser(c))
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow := h.Store.Workflows[c.Params("id")]
	if workflow == nil {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	if h.Store.Users[userID] == nil {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	before := append([]string{}, workflow.AssignedUserIDs...)
	workflow.AssignedUserIDs = appendUniqueUserID(workflow.AssignedUserIDs, userID)
	workflow.UpdatedAt = time.Now().UTC()
	h.Store.Audit(actor, "workflow.user_assigned", models.ResourceRef{Type: "workflow", ID: workflow.ID}, map[string]interface{}{"assignedUserIds": before}, map[string]interface{}{"assignedUserIds": append([]string{}, workflow.AssignedUserIDs...), "userId": userID}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(workflow, "User assigned to workflow", nil))
}

func (h *Handler) UnassignWorkflowUser(c *fiber.Ctx) error {
	userID := c.Params("userId")
	actor := principalFromUser(h.currentUser(c))
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow := h.Store.Workflows[c.Params("id")]
	if workflow == nil {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	before := append([]string{}, workflow.AssignedUserIDs...)
	workflow.AssignedUserIDs = removeUserID(workflow.AssignedUserIDs, userID)
	workflow.UpdatedAt = time.Now().UTC()
	h.Store.Audit(actor, "workflow.user_unassigned", models.ResourceRef{Type: "workflow", ID: workflow.ID}, map[string]interface{}{"assignedUserIds": before}, map[string]interface{}{"assignedUserIds": append([]string{}, workflow.AssignedUserIDs...), "userId": userID}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(workflow, "User unassigned from workflow", nil))
}

func (h *Handler) RestoreWorkflowVersion(c *fiber.Ctx) error {
	stored, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	var selected *models.WorkflowVersion
	h.Store.Mu.RLock()
	for index := range h.Store.Versions[stored.ID] {
		version := h.Store.Versions[stored.ID][index]
		if version.ID == c.Params("versionId") {
			selected = &version
			break
		}
	}
	h.Store.Mu.RUnlock()
	if selected == nil {
		return fiber.NewError(fiber.StatusNotFound, "Workflow version not found")
	}
	token, fullValidation, err := h.validateWithFullGate(c, "RestoreWorkflowVersion", selected.YAML)
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "validate workflow version before restore", "The workflow version could not be checked against the registry before restoring. Try again.", err)
	}
	if !fullValidation.Passed {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow version failed full registry validation", fullValidation))
	}
	domainTags, err := relevance.DomainTagsFromYAML(selected.YAML, h.activeRegistryTools())
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "derive workflow domains before restore", "The workflow domains could not be derived from the active registry. Try again.", err)
	}

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	for _, version := range h.Store.Versions[workflow.ID] {
		if version.ID == c.Params("versionId") {
			if workflowvalidator.WorkflowContentHash(version.YAML) != token.WorkflowContentHash {
				return fiber.NewError(fiber.StatusConflict, "Workflow version changed during validation; retry restoring")
			}
			workflow.YAML = version.YAML
			workflow.DraftVersion++
			workflow.Status = models.StatusPending
			workflow.DomainTags = domainTags
			if fullValidation.ParsedWorkflow != nil {
				workflow.Steps = len(fullValidation.ParsedWorkflow.Steps)
				workflow.Canvas = previewCanvas(workflow.ID, *fullValidation.ParsedWorkflow)
			}
			workflow.UpdatedAt = time.Now().UTC()
			return c.JSON(models.OK(workflow, "Workflow restored", nil))
		}
	}
	return fiber.NewError(fiber.StatusNotFound, "Workflow version not found")
}

func (h *Handler) ListTemplates(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	templates := repository.ListMapValues(h.Store.Templates)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(templates, "OK", nil))
}

func (h *Handler) CreateTemplate(c *fiber.Ctx) error {
	body := decodeMap(c)
	template := &models.WorkflowTemplate{
		ID: "tpl_" + randomHex(4), Name: fmt.Sprint(body["name"]), Description: fmt.Sprint(body["description"]),
		Category: fmt.Sprint(body["category"]), Tags: parseStringSlice(body["tags"]), YAML: fmt.Sprint(body["yaml"]),
		Steps: toInt(body["steps"], 1), CreatedAt: time.Now().UTC(),
	}
	h.Store.Mu.Lock()
	h.Store.Templates[template.ID] = template
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(template, "Template created", nil))
}

func (h *Handler) UseTemplate(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.RLock()
	template, ok := h.Store.Templates[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Template not found")
	}
	name := fmt.Sprint(body["name"])
	if name == "" || name == "<nil>" {
		name = template.Name
	}
	req := models.CreateWorkflowRequest{Name: name, Description: template.Description, YAML: template.YAML, Tags: template.Tags}
	now := time.Now().UTC()
	id := "wf-" + randomHex(4)
	validation, blueprint := h.Validator.ValidateYAML(template.YAML, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Template workflow YAML failed validation", validation))
	}
	_, fullValidation, err := h.validateWithFullGate(c, "UseTemplate", template.YAML)
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "validate template before workflow creation", "The template could not be checked against the registry before creating a workflow. Try again.", err)
	}
	if !fullValidation.Passed {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Template failed full registry validation", fullValidation))
	}
	domainTags, err := relevance.DomainTagsFromBlueprint(blueprint, h.activeRegistryTools())
	if err != nil {
		return h.tracedBusinessError(fiber.StatusInternalServerError, "derive template workflow domains", "The workflow domains could not be derived from the active registry. Try again.", err)
	}
	canvas := previewCanvas(id, blueprint)
	workflow := &models.Workflow{ID: id, Name: req.Name, Description: req.Description, Owner: principalFromUser(h.currentUser(c)), Status: models.StatusPending, Trigger: map[string]interface{}{"type": "template.used", "displayName": template.Name}, Steps: template.Steps, SuccessRate: 0, DraftVersion: 1, Tags: req.Tags, DomainTags: domainTags, YAML: req.YAML, Canvas: canvas, CreatedAt: now, UpdatedAt: now}
	workflow.Canvas.WorkflowID = id
	h.Store.Mu.Lock()
	h.Store.Workflows[id] = workflow
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(workflow, "Template converted to workflow", nil))
}

func (h *Handler) workflowByID(id string) (*models.Workflow, bool) {
	h.Store.Mu.RLock()
	defer h.Store.Mu.RUnlock()
	workflow, ok := h.Store.Workflows[id]
	return workflow, ok
}

func validationMessage(result models.ValidationResult) string {
	if result.Valid {
		return "Workflow is valid"
	}
	return "Workflow is invalid"
}

func registryValidationMessage(result *workflowvalidator.CandidateValidationResult) string {
	if result.Passed {
		return "Workflow is valid"
	}
	return "Workflow is invalid"
}

func canvasExecutionSemanticsChanged(before, after models.WorkflowCanvas) bool {
	type semanticNode struct {
		ID     string
		Type   string
		Config map[string]interface{}
	}
	type semanticEdge struct {
		Source string
		Target string
		Type   string
		Label  *string
	}
	beforeNodes := make([]semanticNode, 0, len(before.Nodes))
	afterNodes := make([]semanticNode, 0, len(after.Nodes))
	for _, node := range before.Nodes {
		beforeNodes = append(beforeNodes, semanticNode{ID: node.ID, Type: node.Type, Config: node.Config})
	}
	for _, node := range after.Nodes {
		afterNodes = append(afterNodes, semanticNode{ID: node.ID, Type: node.Type, Config: node.Config})
	}
	beforeEdges := make([]semanticEdge, 0, len(before.Edges))
	afterEdges := make([]semanticEdge, 0, len(after.Edges))
	for _, edge := range before.Edges {
		beforeEdges = append(beforeEdges, semanticEdge{Source: edge.Source, Target: edge.Target, Type: edge.Type, Label: edge.Label})
	}
	for _, edge := range after.Edges {
		afterEdges = append(afterEdges, semanticEdge{Source: edge.Source, Target: edge.Target, Type: edge.Type, Label: edge.Label})
	}
	return !reflect.DeepEqual(beforeNodes, afterNodes) || !reflect.DeepEqual(beforeEdges, afterEdges)
}

func previewCanvas(workflowID string, blueprint models.WorkflowBlueprint) models.WorkflowCanvas {
	nodes := make([]models.WorkflowNode, 0, len(blueprint.Steps)+1)
	edges := []models.WorkflowEdge{}
	nodes = append(nodes, models.WorkflowNode{ID: "trigger", Label: blueprint.Trigger.DisplayName, Type: "trigger", Position: map[string]float64{"x": 70, "y": 72}, Status: models.StatusPending, Config: blueprint.Trigger.Config})
	prev := "trigger"
	for index, step := range blueprint.Steps {
		id := step.ID
		nodes = append(nodes, models.WorkflowNode{ID: id, Label: step.Action, Type: "action", Position: map[string]float64{"x": float64(330 + index*260), "y": 72}, Status: models.StatusPending, Config: step.Parameters})
		edges = append(edges, models.WorkflowEdge{ID: "edge-" + prev + "-" + id, Source: prev, Target: id, Type: "default"})
		prev = id
	}
	return models.WorkflowCanvas{WorkflowID: workflowID, Nodes: nodes, Edges: edges, Viewport: map[string]interface{}{"x": 0, "y": 0, "zoom": 1}}
}
