package handlers

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/company"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
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

func companyTestApplication() (*Handler, *fiber.App) {
	store := repository.NewStore()
	store.Users["platform"] = &models.User{ID: "platform", Name: "Platform", Status: "Active", RoleID: repository.RolePlatformAdminID}
	store.Users["system"] = &models.User{ID: "system", Name: "System", Status: "Active", RoleID: repository.RoleSystemAdminID}
	store.Users["builder"] = &models.User{ID: "builder", Name: "Builder", Status: "Active", RoleID: repository.RoleBuilderID}
	store.Users["department-user"] = &models.User{ID: "department-user", Name: "Department User", Status: "Active", RoleID: repository.RoleBuilderID}
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
