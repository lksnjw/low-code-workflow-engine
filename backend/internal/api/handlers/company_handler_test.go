package handlers

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/company"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/relevance"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func TestCompanyProfileEditableOnlyByAdminRoles(t *testing.T) {
	handler, app := companyTestApplication()
	valid := validCompanyProfile()
	for _, testCase := range []struct {
		userID string
		status int
	}{
		{userID: "platform", status: fiber.StatusOK},
		{userID: "system", status: fiber.StatusOK},
		{userID: "builder", status: fiber.StatusForbidden},
	} {
		response := registryTestRequest(t, app, http.MethodPut, "/company", testCase.userID, valid)
		body := responseBody(t, response)
		response.Body.Close()
		if response.StatusCode != testCase.status {
			t.Fatalf("%s update status = %d, want %d: %s", testCase.userID, response.StatusCode, testCase.status, body)
		}
	}
	storedProfile, err := company.Decode(handler.Store.CompanyProfile)
	if err != nil || storedProfile.Name != valid.Name {
		t.Fatal("authorized company update did not persist in the repository Store")
	}
}

func TestCompanyProfileRejectsInvalidTimezoneAndCurrency(t *testing.T) {
	_, app := companyTestApplication()
	profile := validCompanyProfile()
	profile.Timezone = "Mars/Olympus"
	profile.Currency = "US"
	response := registryTestRequest(t, app, http.MethodPut, "/company", "platform", profile)
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", response.StatusCode, body)
	}
	if !strings.Contains(body, `"timezone"`) || !strings.Contains(body, `"currency"`) ||
		!strings.Contains(body, "Mars/Olympus") || !strings.Contains(body, "US") {
		t.Fatalf("field errors did not name invalid timezone and currency: %s", body)
	}
}

func TestApprovalTiersMustNotOverlap(t *testing.T) {
	_, app := companyTestApplication()
	profile := validCompanyProfile()
	profile.ApprovalTiers = []company.ApprovalTier{
		{Label: "Tier 1", MaxAmount: 1000, ApproverRoleID: repository.RoleBuilderID},
		{Label: "Tier 2", MaxAmount: 1000, ApproverRoleID: repository.RoleSystemAdminID},
	}
	response := registryTestRequest(t, app, http.MethodPut, "/company", "system", profile)
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusUnprocessableEntity || !strings.Contains(body, "overlaps or is not sorted") {
		t.Fatalf("overlapping approval tiers were not rejected: %d %s", response.StatusCode, body)
	}
}

func TestDepartmentDomainMustMatchActiveRegistryNamespace(t *testing.T) {
	_, app := companyTestApplication()
	profile := validCompanyProfile()
	profile.Departments[0].Domains = []string{"finance", "unknown-domain"}
	response := registryTestRequest(t, app, http.MethodPut, "/company", "platform", profile)
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusUnprocessableEntity || !strings.Contains(body, "unknown-domain") {
		t.Fatalf("unknown department domain was not rejected by name: %d %s", response.StatusCode, body)
	}
}

func TestDepartmentInUseCannotBeDeleted(t *testing.T) {
	handler, app := companyTestApplication()
	departmentID := "dept-finance"
	payload, err := company.Encode(validCompanyProfile())
	if err != nil {
		t.Fatal(err)
	}
	handler.Store.CompanyProfile = payload
	handler.Store.Users["department-user"].DepartmentID = &departmentID
	response := registryTestRequest(t, app, http.MethodDelete, "/company/departments/dept-finance", "platform", nil)
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusConflict || !strings.Contains(body, "1 user(s)") {
		t.Fatalf("in-use department delete status = %d: %s", response.StatusCode, body)
	}
}

// seedCompanyProfile stores the full profile so read-scope tests have real
// cost centres, approval tiers and department domains to leak or withhold.
func seedCompanyProfile(t *testing.T, handler *Handler) company.Profile {
	t.Helper()
	profile := validCompanyProfile()
	handler.Store.Mu.Lock()
	defer handler.Store.Mu.Unlock()
	if err := handler.writeCompanyProfileLocked(profile); err != nil {
		t.Fatalf("seed company profile: %v", err)
	}
	return profile
}

func TestClientCannotReadCostCentresOrApprovalTiers(t *testing.T) {
	handler, app := companyTestApplication()
	seedCompanyProfile(t, handler)
	for _, path := range []string{"/company/cost-centres", "/company/approval-tiers"} {
		for _, testCase := range []struct {
			userID string
			status int
		}{
			{userID: "client", status: fiber.StatusForbidden},
			{userID: "builder", status: fiber.StatusForbidden},
			{userID: "platform", status: fiber.StatusOK},
			{userID: "system", status: fiber.StatusOK},
		} {
			response := registryTestRequest(t, app, http.MethodGet, path, testCase.userID, nil)
			body := responseBody(t, response)
			response.Body.Close()
			if response.StatusCode != testCase.status {
				t.Fatalf("%s GET %s = %d, want %d: %s", testCase.userID, path, response.StatusCode, testCase.status, body)
			}
			if testCase.status == fiber.StatusForbidden && strings.Contains(body, "10000") {
				t.Fatalf("%s GET %s leaked an amount: %s", testCase.userID, path, body)
			}
		}
	}
}

func TestClientReceivesRedactedCompanyProfile(t *testing.T) {
	handler, app := companyTestApplication()
	seedCompanyProfile(t, handler)
	response := registryTestRequest(t, app, http.MethodGet, "/company", "client", nil)
	body := responseBody(t, response)
	response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.StatusCode, body)
	}
	for _, allowed := range []string{"Example Company", "Example Company Limited", "Services", "Asia/Colombo", "LKR", "04-01", "dept-finance", "Finance"} {
		if !strings.Contains(body, allowed) {
			t.Fatalf("redacted profile is missing permitted field %q: %s", allowed, body)
		}
	}
	for _, withheld := range []string{"costCentres", "approvalTiers", "contactEmail", "erpSystemName", "erpVersion", "notes", "domains", "operations@example.test", "Administrator", "10000"} {
		if strings.Contains(body, withheld) {
			t.Fatalf("redacted profile leaked %q: %s", withheld, body)
		}
	}
}

func TestAdminReceivesFullCompanyProfile(t *testing.T) {
	handler, app := companyTestApplication()
	seedCompanyProfile(t, handler)
	for _, userID := range []string{"platform", "system"} {
		response := registryTestRequest(t, app, http.MethodGet, "/company", userID, nil)
		body := responseBody(t, response)
		response.Body.Close()
		if response.StatusCode != fiber.StatusOK {
			t.Fatalf("%s status = %d, want 200: %s", userID, response.StatusCode, body)
		}
		for _, required := range []string{"costCentres", "approvalTiers", "contactEmail", "domains", "operations@example.test", "10000"} {
			if !strings.Contains(body, required) {
				t.Fatalf("%s full profile is missing %q: %s", userID, required, body)
			}
		}
	}
}

// Redaction is presentation-only. Relevance Rule 3 reads the stored profile
// directly through companyProfileLocked, so department domains remain
// available server-side even while the client's HTTP view omits them.
func TestRelevanceStillUsesFullProfileInternally(t *testing.T) {
	handler, app := companyTestApplication()
	seeded := seedCompanyProfile(t, handler)

	response := registryTestRequest(t, app, http.MethodGet, "/company", "client", nil)
	body := responseBody(t, response)
	response.Body.Close()
	if strings.Contains(body, "domains") {
		t.Fatalf("client view exposed department domains: %s", body)
	}

	handler.Store.Mu.RLock()
	internal, err := handler.companyProfileLocked()
	handler.Store.Mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	if len(internal.Departments) != len(seeded.Departments) || len(internal.Departments) == 0 {
		t.Fatalf("internal departments = %#v", internal.Departments)
	}
	if len(internal.Departments[0].Domains) == 0 {
		t.Fatal("internal profile lost department domains, relevance Rule 3 can no longer match")
	}
	if len(internal.CostCentres) == 0 || len(internal.ApprovalTiers) == 0 {
		t.Fatal("internal profile lost cost centres or approval tiers")
	}

	departmentID := internal.Departments[0].ID
	user := &models.User{
		ID: "client", Role: models.RoleRef{Name: "Client"},
		Permissions: []string{"workflow:read_own"}, DepartmentID: &departmentID,
	}
	workflow := &models.Workflow{ID: "wf", Owner: models.Principal{ID: "someone-else"}, DomainTags: []string{"finance"}}
	if result := relevance.Evaluate(user, workflow, internal, handler.activeRegistryTools()); !result.Rule3 || !result.Relevant {
		t.Fatalf("relevance evaluation with the full profile = %#v", result)
	}
}

func companyTestApplication() (*Handler, *fiber.App) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{ID: "platform", Name: "Platform", Status: "Active", RoleID: repository.RolePlatformAdminID}
	store.Users["system"] = &models.User{ID: "system", Name: "System", Status: "Active", RoleID: repository.RoleSystemAdminID}
	store.Users["builder"] = &models.User{ID: "builder", Name: "Builder", Status: "Active", RoleID: repository.RoleBuilderID}
	store.Users["department-user"] = &models.User{ID: "department-user", Name: "Department User", Status: "Active", RoleID: repository.RoleBuilderID}
	store.Users["client"] = &models.User{ID: "client", Name: "Client", Status: "Active", RoleID: repository.RoleClientID}
	tools := []registry.Tool{
		{ToolID: "TOOL-FINANCE", Name: "finance.read", Module: "finance", Status: "active_mcp_schema_present"},
		{ToolID: "TOOL-HR", Name: "hr.read", Module: "hr", Status: "active_mcp_schema_present"},
	}
	bundle := &registry.Bundle{
		Tools: registry.NewToolRegistry(tools, "tools-company"),
		Rules: registry.NewRuleRegistry(nil, "rules-company"),
	}
	handler := &Handler{Store: store, Dataset: bundle, RegistryManager: registry.NewManager(bundle, "", "")}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middlewares.UserIDKey, c.Get("X-Test-User"))
		return c.Next()
	})
	app.Get("/company", handler.GetCompany)
	app.Put("/company", handler.UpdateCompany)
	app.Delete("/company/departments/:id", handler.DeleteCompanyDepartment)
	app.Get("/company/departments", handler.ListCompanyDepartments)
	app.Get("/company/cost-centres", handler.ListCompanyCostCentres)
	app.Get("/company/approval-tiers", handler.ListCompanyApprovalTiers)
	return handler, app
}

func validCompanyProfile() company.Profile {
	return company.Profile{
		Name: "Example Company", LegalName: "Example Company Limited", Industry: "Services",
		Timezone: "Asia/Colombo", Currency: "LKR", FiscalYearStart: "04-01",
		ContactEmail: "operations@example.test", ERPSystemName: "Example ERP", ERPVersion: "1",
		Departments: []company.Department{{ID: "dept-finance", Name: "Finance", Domains: []string{"finance"}}},
		CostCentres: []company.CostCentre{{Code: "FIN", Name: "Finance", BudgetAmount: 10000, Currency: "LKR"}},
		ApprovalTiers: []company.ApprovalTier{
			{Label: "Manager", MaxAmount: 1000, ApproverRoleID: repository.RoleBuilderID},
			{Label: "Administrator", MaxAmount: 10000, ApproverRoleID: repository.RoleSystemAdminID},
		},
	}
}
