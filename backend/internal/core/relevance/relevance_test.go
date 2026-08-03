package relevance

import (
	"slices"
	"testing"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/company"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestDomainTagsDerivedFromToolNamespaces(t *testing.T) {
	tags, err := DomainTagsFromYAML(twoDomainWorkflowYAML(), relevanceTools())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(tags, []string{"finance", "procurement"}) {
		t.Fatalf("domain tags = %#v", tags)
	}
}

func TestDomainTagBackfillIsIdempotent(t *testing.T) {
	store := repository.NewStore()
	store.Workflows["workflow"] = &models.Workflow{ID: "workflow", YAML: twoDomainWorkflowYAML()}
	first, err := BackfillWorkflowDomainTags(store, relevanceTools())
	if err != nil {
		t.Fatal(err)
	}
	second, err := BackfillWorkflowDomainTags(store, relevanceTools())
	if err != nil {
		t.Fatal(err)
	}
	if first != 1 || second != 0 {
		t.Fatalf("backfill counts = first %d second %d", first, second)
	}
	if !slices.Equal(store.Workflows["workflow"].DomainTags, []string{"finance", "procurement"}) {
		t.Fatalf("backfilled tags = %#v", store.Workflows["workflow"].DomainTags)
	}
}

// Tools such as classify_invoice and policy_check carry no dotted namespace.
// company.ToolNamespace already resolves Module first, so those tools still
// yield a usable domain tag and relevance Rule 3 can match them. This test
// locks that in.
func TestDomainTagFallsBackToModuleForUnnamespacedTools(t *testing.T) {
	tools := []registry.Tool{
		{ToolID: "CLS", Name: "classify_invoice", Module: "finance", Status: "active_mcp_schema_present"},
		{ToolID: "POL", Name: "policy_check", Module: "governance", Status: "active_mcp_schema_present"},
	}
	yaml := "name: undotted\ntrigger:\n  type: manual\nsteps:\n" +
		"  - id: classify\n    action: classify_invoice\n" +
		"  - id: policy\n    action: policy_check\n"

	tags, err := DomainTagsFromYAML(yaml, tools)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(tags, []string{"finance", "governance"}) {
		t.Fatalf("domain tags = %#v, want [finance governance]", tags)
	}
	for _, tag := range tags {
		if tag == "" {
			t.Fatal("an unnamespaced tool produced an empty domain tag")
		}
	}

	// Rule 3 must match a department whose domain is the module-derived tag.
	departmentID := "dept-finance"
	user := effectiveUser("reviewer", "Execution Reviewer", []string{"workflow:read"}, &departmentID)
	profile := company.DefaultProfile()
	profile.Departments = []company.Department{{ID: departmentID, Name: "Finance", Domains: []string{"finance"}}}
	workflow := workflowForAction("undotted-workflow", "classify_invoice", tags)
	if result := Evaluate(user, workflow, profile, tools); !result.Rule3 || !result.Relevant {
		t.Fatalf("unnamespaced tool relevance evaluation = %#v", result)
	}
}

func TestRelevanceRule2ExcludesUnrunnableWorkflows(t *testing.T) {
	builder := effectiveUser("builder", "Workflow Builder", []string{"workflow:read", "workflow:run"}, nil)
	runnable := workflowForAction("runnable", "finance.read", []string{"finance"})
	blocked := workflowForAction("blocked", "hr.private", []string{"hr"})
	if result := Evaluate(builder, runnable, company.DefaultProfile(), relevanceTools()); !result.Rule2 || !result.Relevant || !result.CanRun {
		t.Fatalf("runnable workflow evaluation = %#v", result)
	}
	if result := Evaluate(builder, blocked, company.DefaultProfile(), relevanceTools()); result.Rule2 || result.Relevant || result.CanRun {
		t.Fatalf("unrunnable workflow evaluation = %#v", result)
	}
}

func TestRelevanceRule3MatchesDepartmentDomains(t *testing.T) {
	departmentID := "dept-finance"
	user := effectiveUser("reviewer", "Execution Reviewer", []string{"workflow:read"}, &departmentID)
	profile := company.DefaultProfile()
	profile.Departments = []company.Department{{ID: departmentID, Name: "Finance", Domains: []string{"finance"}}}
	workflow := workflowForAction("finance-workflow", "finance.read", []string{"finance"})
	result := Evaluate(user, workflow, profile, relevanceTools())
	if !result.Rule3 || !result.Relevant || result.Rule2 {
		t.Fatalf("department relevance evaluation = %#v", result)
	}
}

func relevanceTools() []registry.Tool {
	return []registry.Tool{
		{ToolID: "FIN", Name: "finance.read", Module: "finance", Status: "active_mcp_schema_present", AllowedRoles: []string{"Workflow Builder"}},
		{ToolID: "PROC", Name: "procurement.create", Module: "procurement", Status: "active_mcp_schema_present", AllowedRoles: []string{"Workflow Builder"}},
		{ToolID: "HR", Name: "hr.private", Module: "hr", Status: "active_mcp_schema_present", AllowedRoles: []string{"HR Manager"}},
	}
}

func effectiveUser(id, role string, permissions []string, departmentID *string) *models.User {
	return &models.User{
		ID: id, Role: models.RoleRef{Name: role}, Permissions: permissions,
		DepartmentID: departmentID,
	}
}

func workflowForAction(id, action string, domainTags []string) *models.Workflow {
	return &models.Workflow{
		ID: id, Owner: models.Principal{ID: "somebody-else"}, DomainTags: domainTags,
		YAML:      "name: " + id + "\ntrigger:\n  type: manual\nsteps:\n  - id: step\n    action: " + action + "\n",
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
}

func twoDomainWorkflowYAML() string {
	return `name: cross-domain
trigger:
  type: manual
steps:
  - id: finance
    action: finance.read
  - id: procurement
    action: procurement.create
`
}
