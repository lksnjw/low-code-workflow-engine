package handlers

import (
	"fmt"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/company"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

// redactedCompanyDepartment hides department domains, which describe the
// internal tool namespaces a department owns.
type redactedCompanyDepartment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// redactedCompanyProfile is what a non-administrator receives. Contact email,
// ERP system details, notes, cost centres (budget amounts) and approval tiers
// (spend thresholds) are absent from the type, so they cannot leak.
type redactedCompanyProfile struct {
	Name            string                      `json:"name"`
	LegalName       string                      `json:"legalName"`
	Industry        string                      `json:"industry"`
	Timezone        string                      `json:"timezone"`
	Currency        string                      `json:"currency"`
	FiscalYearStart string                      `json:"fiscalYearStart"`
	Departments     []redactedCompanyDepartment `json:"departments"`
}

// isCompanyAdministrator reports whether the caller may see unrestricted
// company data. It is the single source of truth for company read scope.
func isCompanyAdministrator(user *models.User) bool {
	if user == nil {
		return false
	}
	switch user.AssignedRoleID() {
	case repository.RolePlatformAdminID, repository.RoleSystemAdminID:
		return true
	default:
		return false
	}
}

func redactCompanyProfile(profile company.Profile) redactedCompanyProfile {
	departments := make([]redactedCompanyDepartment, 0, len(profile.Departments))
	for _, department := range profile.Departments {
		departments = append(departments, redactedCompanyDepartment{ID: department.ID, Name: department.Name})
	}
	return redactedCompanyProfile{
		Name:            profile.Name,
		LegalName:       profile.LegalName,
		Industry:        profile.Industry,
		Timezone:        profile.Timezone,
		Currency:        profile.Currency,
		FiscalYearStart: profile.FiscalYearStart,
		Departments:     departments,
	}
}

// requireCompanyReader restricts a company sub-resource to administrators.
func (h *Handler) requireCompanyReader(c *fiber.Ctx) error {
	user := h.currentUser(c)
	if user == nil {
		return fiber.NewError(fiber.StatusUnauthorized, "Authenticated user no longer exists")
	}
	if !isCompanyAdministrator(user) {
		return fiber.NewError(fiber.StatusForbidden, "Only Platform Admin and System Admin roles can read this company data")
	}
	return nil
}

func (h *Handler) GetCompany(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	profile, err := h.companyProfileLocked()
	h.Store.Mu.RUnlock()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	if !isCompanyAdministrator(h.currentUser(c)) {
		return c.JSON(models.OK(redactCompanyProfile(profile), "Company profile loaded", nil))
	}
	return c.JSON(models.OK(profile, "Company profile loaded", nil))
}

func (h *Handler) UpdateCompany(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	var requested company.Profile
	if err := h.parseBody(c, &requested); err != nil {
		return err
	}
	requested = company.Normalize(requested)
	if fieldErrors := company.Validate(requested, h.activeRegistryTools()); len(fieldErrors) > 0 {
		return companyValidationResponse(c, fieldErrors)
	}

	h.Store.Mu.Lock()
	before, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	if writeErr := h.writeCompanyProfileLocked(requested); writeErr != nil {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	h.Store.Audit(principalFromUser(actor), "company.updated", models.ResourceRef{Type: "company", ID: "company"}, companyAuditState(before), companyAuditState(requested), c.IP(), c.Get("User-Agent"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(requested, "Company profile updated", nil))
}

func (h *Handler) ListCompanyDepartments(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	profile, err := h.companyProfileLocked()
	h.Store.Mu.RUnlock()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	// Domains are withheld from non-administrators here for the same reason
	// they are withheld from GET /company.
	if !isCompanyAdministrator(h.currentUser(c)) {
		redacted := redactCompanyProfile(profile).Departments
		return c.JSON(models.OK(redacted, "Company departments loaded", map[string]interface{}{"count": len(redacted)}))
	}
	departments := profile.Departments
	return c.JSON(models.OK(departments, "Company departments loaded", map[string]interface{}{"count": len(departments)}))
}

func (h *Handler) CreateCompanyDepartment(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	var department company.Department
	if err := h.parseBody(c, &department); err != nil {
		return err
	}
	if strings.TrimSpace(department.ID) == "" {
		department.ID = "dept_" + randomHex(4)
	}

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	for _, existing := range profile.Departments {
		if strings.EqualFold(existing.ID, department.ID) {
			return c.Status(fiber.StatusConflict).JSON(models.Fail(fmt.Sprintf("Department id %q already exists", department.ID), nil))
		}
	}
	profile.Departments = append(profile.Departments, department)
	profile = company.Normalize(profile)
	if fieldErrors := company.Validate(profile, h.activeRegistryTools()); len(fieldErrors) > 0 {
		return companyValidationResponse(c, fieldErrors)
	}
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	created := profile.Departments[len(profile.Departments)-1]
	h.Store.Audit(principalFromUser(actor), "company.department.created", models.ResourceRef{Type: "company_department", ID: created.ID}, nil, map[string]interface{}{"name": created.Name, "domains": created.Domains}, c.IP(), c.Get("User-Agent"))
	return c.Status(fiber.StatusCreated).JSON(models.OK(created, "Company department created", nil))
}

func (h *Handler) UpdateCompanyDepartment(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	var department company.Department
	if err := h.parseBody(c, &department); err != nil {
		return err
	}
	department.ID = c.Params("id")

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	index := departmentIndex(profile.Departments, c.Params("id"))
	if index < 0 {
		return fiber.NewError(fiber.StatusNotFound, "Department not found")
	}
	before := profile.Departments[index]
	profile.Departments[index] = department
	profile = company.Normalize(profile)
	if fieldErrors := company.Validate(profile, h.activeRegistryTools()); len(fieldErrors) > 0 {
		return companyValidationResponse(c, fieldErrors)
	}
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	updated := profile.Departments[index]
	h.Store.Audit(principalFromUser(actor), "company.department.updated", models.ResourceRef{Type: "company_department", ID: updated.ID}, map[string]interface{}{"name": before.Name, "domains": before.Domains}, map[string]interface{}{"name": updated.Name, "domains": updated.Domains}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(updated, "Company department updated", nil))
}

func (h *Handler) DeleteCompanyDepartment(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	index := departmentIndex(profile.Departments, c.Params("id"))
	if index < 0 {
		return fiber.NewError(fiber.StatusNotFound, "Department not found")
	}
	usersInDepartment := 0
	for _, user := range h.Store.Users {
		if user != nil && user.DepartmentID != nil && strings.EqualFold(*user.DepartmentID, c.Params("id")) {
			usersInDepartment++
		}
	}
	if usersInDepartment > 0 {
		return c.Status(fiber.StatusConflict).JSON(models.Fail(
			fmt.Sprintf("Department is assigned to %d user(s)", usersInDepartment),
			map[string]interface{}{"users": usersInDepartment},
		))
	}
	department := profile.Departments[index]
	profile.Departments = append(profile.Departments[:index], profile.Departments[index+1:]...)
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	h.Store.Audit(principalFromUser(actor), "company.department.deleted", models.ResourceRef{Type: "company_department", ID: department.ID}, map[string]interface{}{"name": department.Name, "domains": department.Domains}, nil, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Company department deleted", nil))
}

func (h *Handler) ListCompanyCostCentres(c *fiber.Ctx) error {
	if err := h.requireCompanyReader(c); err != nil {
		return err
	}
	h.Store.Mu.RLock()
	profile, err := h.companyProfileLocked()
	h.Store.Mu.RUnlock()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	costCentres := profile.CostCentres
	return c.JSON(models.OK(costCentres, "Company cost centres loaded", map[string]interface{}{"count": len(costCentres)}))
}

func (h *Handler) CreateCompanyCostCentre(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	var costCentre company.CostCentre
	if err := h.parseBody(c, &costCentre); err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	if costCentreIndex(profile.CostCentres, costCentre.Code) >= 0 {
		return c.Status(fiber.StatusConflict).JSON(models.Fail(fmt.Sprintf("Cost centre code %q already exists", costCentre.Code), nil))
	}
	profile.CostCentres = append(profile.CostCentres, costCentre)
	profile = company.Normalize(profile)
	if fieldErrors := company.Validate(profile, h.activeRegistryTools()); len(fieldErrors) > 0 {
		return companyValidationResponse(c, fieldErrors)
	}
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	created := profile.CostCentres[len(profile.CostCentres)-1]
	h.Store.Audit(principalFromUser(actor), "company.cost_centre.created", models.ResourceRef{Type: "company_cost_centre", ID: created.Code}, nil, map[string]interface{}{"name": created.Name, "budgetAmount": created.BudgetAmount}, c.IP(), c.Get("User-Agent"))
	return c.Status(fiber.StatusCreated).JSON(models.OK(created, "Company cost centre created", nil))
}

func (h *Handler) UpdateCompanyCostCentre(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	var costCentre company.CostCentre
	if err := h.parseBody(c, &costCentre); err != nil {
		return err
	}
	costCentre.Code = c.Params("id")
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	index := costCentreIndex(profile.CostCentres, c.Params("id"))
	if index < 0 {
		return fiber.NewError(fiber.StatusNotFound, "Cost centre not found")
	}
	before := profile.CostCentres[index]
	profile.CostCentres[index] = costCentre
	profile = company.Normalize(profile)
	if fieldErrors := company.Validate(profile, h.activeRegistryTools()); len(fieldErrors) > 0 {
		return companyValidationResponse(c, fieldErrors)
	}
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	updated := profile.CostCentres[index]
	h.Store.Audit(principalFromUser(actor), "company.cost_centre.updated", models.ResourceRef{Type: "company_cost_centre", ID: updated.Code}, map[string]interface{}{"name": before.Name, "budgetAmount": before.BudgetAmount}, map[string]interface{}{"name": updated.Name, "budgetAmount": updated.BudgetAmount}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(updated, "Company cost centre updated", nil))
}

func (h *Handler) DeleteCompanyCostCentre(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	index := costCentreIndex(profile.CostCentres, c.Params("id"))
	if index < 0 {
		return fiber.NewError(fiber.StatusNotFound, "Cost centre not found")
	}
	costCentre := profile.CostCentres[index]
	profile.CostCentres = append(profile.CostCentres[:index], profile.CostCentres[index+1:]...)
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	h.Store.Audit(principalFromUser(actor), "company.cost_centre.deleted", models.ResourceRef{Type: "company_cost_centre", ID: costCentre.Code}, map[string]interface{}{"name": costCentre.Name}, nil, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Company cost centre deleted", nil))
}

func (h *Handler) ListCompanyApprovalTiers(c *fiber.Ctx) error {
	if err := h.requireCompanyReader(c); err != nil {
		return err
	}
	h.Store.Mu.RLock()
	profile, err := h.companyProfileLocked()
	h.Store.Mu.RUnlock()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	approvalTiers := profile.ApprovalTiers
	return c.JSON(models.OK(approvalTiers, "Company approval tiers loaded", map[string]interface{}{"count": len(approvalTiers)}))
}

func (h *Handler) CreateCompanyApprovalTier(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	var tier company.ApprovalTier
	if err := h.parseBody(c, &tier); err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	if approvalTierIndex(profile.ApprovalTiers, tier.Label) >= 0 {
		return c.Status(fiber.StatusConflict).JSON(models.Fail(fmt.Sprintf("Approval tier label %q already exists", tier.Label), nil))
	}
	profile.ApprovalTiers = append(profile.ApprovalTiers, tier)
	profile = company.Normalize(profile)
	if fieldErrors := company.Validate(profile, h.activeRegistryTools()); len(fieldErrors) > 0 {
		return companyValidationResponse(c, fieldErrors)
	}
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	created := profile.ApprovalTiers[len(profile.ApprovalTiers)-1]
	h.Store.Audit(principalFromUser(actor), "company.approval_tier.created", models.ResourceRef{Type: "company_approval_tier", ID: created.Label}, nil, map[string]interface{}{"maxAmount": created.MaxAmount, "approverRoleId": created.ApproverRoleID}, c.IP(), c.Get("User-Agent"))
	return c.Status(fiber.StatusCreated).JSON(models.OK(created, "Company approval tier created", nil))
}

func (h *Handler) UpdateCompanyApprovalTier(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	var tier company.ApprovalTier
	if err := h.parseBody(c, &tier); err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	index := approvalTierIndex(profile.ApprovalTiers, c.Params("id"))
	if index < 0 {
		return fiber.NewError(fiber.StatusNotFound, "Approval tier not found")
	}
	before := profile.ApprovalTiers[index]
	profile.ApprovalTiers[index] = tier
	profile = company.Normalize(profile)
	if fieldErrors := company.Validate(profile, h.activeRegistryTools()); len(fieldErrors) > 0 {
		return companyValidationResponse(c, fieldErrors)
	}
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	updated := profile.ApprovalTiers[index]
	h.Store.Audit(principalFromUser(actor), "company.approval_tier.updated", models.ResourceRef{Type: "company_approval_tier", ID: updated.Label}, map[string]interface{}{"maxAmount": before.MaxAmount, "approverRoleId": before.ApproverRoleID}, map[string]interface{}{"maxAmount": updated.MaxAmount, "approverRoleId": updated.ApproverRoleID}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(updated, "Company approval tier updated", nil))
}

func (h *Handler) DeleteCompanyApprovalTier(c *fiber.Ctx) error {
	actor, err := h.requireCompanyAdministrator(c)
	if err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	profile, decodeErr := h.companyProfileLocked()
	if decodeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Stored company profile could not be decoded")
	}
	index := approvalTierIndex(profile.ApprovalTiers, c.Params("id"))
	if index < 0 {
		return fiber.NewError(fiber.StatusNotFound, "Approval tier not found")
	}
	tier := profile.ApprovalTiers[index]
	profile.ApprovalTiers = append(profile.ApprovalTiers[:index], profile.ApprovalTiers[index+1:]...)
	if writeErr := h.writeCompanyProfileLocked(profile); writeErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Company profile could not be encoded")
	}
	h.Store.Audit(principalFromUser(actor), "company.approval_tier.deleted", models.ResourceRef{Type: "company_approval_tier", ID: tier.Label}, map[string]interface{}{"maxAmount": tier.MaxAmount, "approverRoleId": tier.ApproverRoleID}, nil, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Company approval tier deleted", nil))
}

func (h *Handler) requireCompanyAdministrator(c *fiber.Ctx) (*models.User, error) {
	user := h.currentUser(c)
	if user == nil {
		return nil, fiber.NewError(fiber.StatusUnauthorized, "Authenticated user no longer exists")
	}
	if !isCompanyAdministrator(user) {
		return nil, fiber.NewError(fiber.StatusForbidden, "Only Platform Admin and System Admin roles can edit the company profile")
	}
	return user, nil
}

func (h *Handler) activeRegistryRules() []registry.Rule {
	if h.RegistryManager != nil {
		return h.RegistryManager.Rules()
	}
	if h.Dataset != nil && h.Dataset.Rules != nil {
		return h.Dataset.Rules.GetAllRules()
	}
	return []registry.Rule{}
}

func (h *Handler) activeRegistryTools() []registry.Tool {
	if h.RegistryManager != nil {
		return h.RegistryManager.Tools()
	}
	if h.Dataset != nil && h.Dataset.Tools != nil {
		return h.Dataset.Tools.GetAllTools()
	}
	return []registry.Tool{}
}

func companyValidationResponse(c *fiber.Ctx, fieldErrors map[string]string) error {
	return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail(
		"Company profile validation failed",
		map[string]interface{}{"fieldErrors": fieldErrors},
	))
}

func departmentIndex(departments []company.Department, id string) int {
	for index, department := range departments {
		if strings.EqualFold(department.ID, id) {
			return index
		}
	}
	return -1
}

func costCentreIndex(costCentres []company.CostCentre, code string) int {
	for index, costCentre := range costCentres {
		if strings.EqualFold(costCentre.Code, code) {
			return index
		}
	}
	return -1
}

func approvalTierIndex(tiers []company.ApprovalTier, label string) int {
	for index, tier := range tiers {
		if strings.EqualFold(tier.Label, label) {
			return index
		}
	}
	return -1
}

func companyAuditState(profile company.Profile) map[string]interface{} {
	return map[string]interface{}{
		"name":            profile.Name,
		"legalName":       profile.LegalName,
		"departments":     len(profile.Departments),
		"costCentres":     len(profile.CostCentres),
		"approvalTiers":   len(profile.ApprovalTiers),
		"erpSystemName":   profile.ERPSystemName,
		"erpVersion":      profile.ERPVersion,
		"companyTimezone": profile.Timezone,
		"companyCurrency": profile.Currency,
		"fiscalYearStart": profile.FiscalYearStart,
		"companyContact":  profile.ContactEmail,
		"companyIndustry": profile.Industry,
	}
}

func (h *Handler) companyProfileLocked() (company.Profile, error) {
	return company.Decode(h.Store.CompanyProfile)
}

func (h *Handler) writeCompanyProfileLocked(profile company.Profile) error {
	payload, err := company.Encode(profile)
	if err != nil {
		return err
	}
	h.Store.CompanyProfile = payload
	return nil
}
