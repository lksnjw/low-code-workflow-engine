package relevance

import (
	"fmt"
	"slices"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/company"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

type Result struct {
	Relevant bool
	CanRun   bool
	Rule1    bool
	Rule2    bool
	Rule3    bool
}

func Evaluate(user *models.User, workflow *models.Workflow, profile company.Profile, tools []registry.Tool) Result {
	if user == nil || workflow == nil {
		return Result{}
	}
	rule1 := assignedToUser(workflow, user)
	rule2 := CanExecuteEndToEnd(user, workflow, tools)
	rule3 := departmentMatches(user, workflow, profile)
	return Result{
		Relevant: rule1 || rule2 || rule3,
		CanRun:   rule2,
		Rule1:    rule1,
		Rule2:    rule2,
		Rule3:    rule3,
	}
}

func CanExecuteEndToEnd(user *models.User, workflow *models.Workflow, tools []registry.Tool) bool {
	if user == nil || workflow == nil || !hasRunScope(user, workflow) {
		return false
	}
	blueprint, err := parser.ParseWorkflowYAML(workflow.YAML)
	if err != nil || len(blueprint.Steps) == 0 {
		return false
	}
	toolByName := toolLookup(tools)
	for _, step := range blueprint.Steps {
		tool, exists := toolByName[normalize(step.Action)]
		if !exists ||
			!strings.EqualFold(strings.TrimSpace(tool.Status), "active_mcp_schema_present") ||
			!roleAllowed(user.Role.Name, tool.AllowedRoles) {
			return false
		}
	}
	return true
}

func DomainTagsFromYAML(rawYAML string, tools []registry.Tool) ([]string, error) {
	blueprint, err := parser.ParseWorkflowYAML(rawYAML)
	if err != nil {
		return nil, err
	}
	return DomainTagsFromBlueprint(blueprint, tools)
}

func DomainTagsFromBlueprint(blueprint models.WorkflowBlueprint, tools []registry.Tool) ([]string, error) {
	toolByName := toolLookup(tools)
	domains := map[string]struct{}{}
	for _, step := range blueprint.Steps {
		tool, exists := toolByName[normalize(step.Action)]
		if !exists {
			return nil, fmt.Errorf("workflow step %s uses unregistered tool %q", step.ID, step.Action)
		}
		namespace := company.ToolNamespace(tool)
		if namespace != "" {
			domains[namespace] = struct{}{}
		}
	}
	return company.DomainList(domains), nil
}

func BackfillWorkflowDomainTags(store *repository.Store, tools []registry.Tool) (int, error) {
	if store == nil {
		return 0, fmt.Errorf("workflow domain-tag backfill requires a store")
	}
	store.Mu.Lock()
	defer store.Mu.Unlock()
	updates := 0
	for id, workflow := range store.Workflows {
		if workflow == nil {
			continue
		}
		domainTags, err := DomainTagsFromYAML(workflow.YAML, tools)
		if err != nil {
			return updates, fmt.Errorf("derive domain tags for workflow %s: %w", id, err)
		}
		if slices.Equal(workflow.DomainTags, domainTags) {
			continue
		}
		workflow.DomainTags = domainTags
		updates++
	}
	return updates, nil
}

func assignedToUser(workflow *models.Workflow, user *models.User) bool {
	if workflow.Owner.ID == user.ID {
		return true
	}
	for _, userID := range workflow.AssignedUserIDs {
		if userID == user.ID {
			return true
		}
	}
	return false
}

func hasRunScope(user *models.User, workflow *models.Workflow) bool {
	if hasPermission(user, "workflow:run") {
		return true
	}
	return hasPermission(user, "workflow:run_own") && assignedToUser(workflow, user)
}

func departmentMatches(user *models.User, workflow *models.Workflow, profile company.Profile) bool {
	if user.DepartmentID == nil || len(workflow.DomainTags) == 0 {
		return false
	}
	workflowDomains := make(map[string]struct{}, len(workflow.DomainTags))
	for _, domain := range workflow.DomainTags {
		workflowDomains[normalize(domain)] = struct{}{}
	}
	for _, department := range profile.Departments {
		if !strings.EqualFold(department.ID, *user.DepartmentID) {
			continue
		}
		for _, domain := range department.Domains {
			if _, exists := workflowDomains[normalize(domain)]; exists {
				return true
			}
		}
	}
	return false
}

func toolLookup(tools []registry.Tool) map[string]registry.Tool {
	lookup := make(map[string]registry.Tool, len(tools)*2)
	for _, tool := range tools {
		lookup[normalize(tool.Name)] = tool
		if strings.TrimSpace(tool.MCPToolName) != "" {
			lookup[normalize(tool.MCPToolName)] = tool
		}
	}
	return lookup
}

func roleAllowed(role string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	normalizedRole := normalizeRole(role)
	if normalizedRole == "admin" || normalizedRole == "platform_admin" {
		return true
	}
	for _, allowedRole := range allowed {
		if normalizeRole(allowedRole) == normalizedRole {
			return true
		}
	}
	return false
}

func hasPermission(user *models.User, permission string) bool {
	for _, current := range user.Permissions {
		if current == permission {
			return true
		}
	}
	return false
}

func normalizeRole(role string) string {
	role = normalize(role)
	role = strings.ReplaceAll(role, " ", "_")
	role = strings.ReplaceAll(role, "-", "_")
	if role == "platform_admin" {
		return "admin"
	}
	return role
}

func normalize(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
