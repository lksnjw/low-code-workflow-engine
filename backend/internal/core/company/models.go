package company

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

type Profile struct {
	Name            string         `json:"name"`
	LegalName       string         `json:"legalName"`
	Industry        string         `json:"industry"`
	Timezone        string         `json:"timezone"`
	Currency        string         `json:"currency"`
	FiscalYearStart string         `json:"fiscalYearStart"`
	ContactEmail    string         `json:"contactEmail"`
	ERPSystemName   string         `json:"erpSystemName"`
	ERPVersion      string         `json:"erpVersion"`
	Notes           string         `json:"notes"`
	Departments     []Department   `json:"departments"`
	CostCentres     []CostCentre   `json:"costCentres"`
	ApprovalTiers   []ApprovalTier `json:"approvalTiers"`
}

type Department struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Domains []string `json:"domains"`
}

type CostCentre struct {
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	OwnerUserID  string  `json:"ownerUserId"`
	BudgetAmount float64 `json:"budgetAmount"`
	Currency     string  `json:"currency"`
}

type ApprovalTier struct {
	Label          string  `json:"label"`
	MaxAmount      float64 `json:"maxAmount"`
	ApproverRoleID string  `json:"approverRoleId"`
}

func DefaultProfile() Profile {
	return Profile{
		Timezone:      "UTC",
		Currency:      "USD",
		Departments:   []Department{},
		CostCentres:   []CostCentre{},
		ApprovalTiers: []ApprovalTier{},
	}
}

func Encode(profile Profile) (json.RawMessage, error) {
	payload, err := json.Marshal(Clone(profile))
	if err != nil {
		return nil, fmt.Errorf("encode company profile: %w", err)
	}
	return json.RawMessage(payload), nil
}

func Decode(payload json.RawMessage) (Profile, error) {
	if len(payload) == 0 {
		return DefaultProfile(), nil
	}
	var profile Profile
	if err := json.Unmarshal(payload, &profile); err != nil {
		return Profile{}, fmt.Errorf("decode company profile: %w", err)
	}
	if IsZero(profile) {
		return DefaultProfile(), nil
	}
	return Normalize(profile), nil
}

func Clone(profile Profile) Profile {
	out := profile
	out.Departments = make([]Department, len(profile.Departments))
	for index, department := range profile.Departments {
		out.Departments[index] = department
		out.Departments[index].Domains = append([]string(nil), department.Domains...)
	}
	out.CostCentres = append([]CostCentre(nil), profile.CostCentres...)
	out.ApprovalTiers = append([]ApprovalTier(nil), profile.ApprovalTiers...)
	return out
}

func Normalize(profile Profile) Profile {
	profile.Name = strings.TrimSpace(profile.Name)
	profile.LegalName = strings.TrimSpace(profile.LegalName)
	profile.Industry = strings.TrimSpace(profile.Industry)
	profile.Timezone = strings.TrimSpace(profile.Timezone)
	profile.Currency = strings.ToUpper(strings.TrimSpace(profile.Currency))
	profile.FiscalYearStart = strings.TrimSpace(profile.FiscalYearStart)
	profile.ContactEmail = strings.TrimSpace(profile.ContactEmail)
	profile.ERPSystemName = strings.TrimSpace(profile.ERPSystemName)
	profile.ERPVersion = strings.TrimSpace(profile.ERPVersion)
	profile.Notes = strings.TrimSpace(profile.Notes)
	if profile.Departments == nil {
		profile.Departments = []Department{}
	}
	for index := range profile.Departments {
		profile.Departments[index].ID = strings.TrimSpace(profile.Departments[index].ID)
		profile.Departments[index].Name = strings.TrimSpace(profile.Departments[index].Name)
		profile.Departments[index].Domains = normalizeDomains(profile.Departments[index].Domains)
	}
	if profile.CostCentres == nil {
		profile.CostCentres = []CostCentre{}
	}
	for index := range profile.CostCentres {
		profile.CostCentres[index].Code = strings.TrimSpace(profile.CostCentres[index].Code)
		profile.CostCentres[index].Name = strings.TrimSpace(profile.CostCentres[index].Name)
		profile.CostCentres[index].OwnerUserID = strings.TrimSpace(profile.CostCentres[index].OwnerUserID)
		profile.CostCentres[index].Currency = strings.ToUpper(strings.TrimSpace(profile.CostCentres[index].Currency))
	}
	if profile.ApprovalTiers == nil {
		profile.ApprovalTiers = []ApprovalTier{}
	}
	for index := range profile.ApprovalTiers {
		profile.ApprovalTiers[index].Label = strings.TrimSpace(profile.ApprovalTiers[index].Label)
		profile.ApprovalTiers[index].ApproverRoleID = strings.TrimSpace(profile.ApprovalTiers[index].ApproverRoleID)
	}
	return profile
}

func Validate(profile Profile, tools []registry.Tool) map[string]string {
	errorsByField := map[string]string{}
	if profile.Timezone == "" {
		errorsByField["timezone"] = "timezone is required"
	} else if _, err := time.LoadLocation(profile.Timezone); err != nil {
		errorsByField["timezone"] = fmt.Sprintf("timezone %q is not a valid IANA timezone", profile.Timezone)
	}
	if !validCurrency(profile.Currency) {
		errorsByField["currency"] = fmt.Sprintf("currency %q must be a 3-letter code", profile.Currency)
	}

	activeNamespaces := ActiveNamespaces(tools)
	departmentIDs := map[string]struct{}{}
	for departmentIndex, department := range profile.Departments {
		idKey := strings.ToLower(department.ID)
		if department.ID == "" {
			errorsByField[fmt.Sprintf("departments.%d.id", departmentIndex)] = "department id is required"
		} else if _, exists := departmentIDs[idKey]; exists {
			errorsByField[fmt.Sprintf("departments.%d.id", departmentIndex)] = fmt.Sprintf("department id %q is duplicated", department.ID)
		}
		departmentIDs[idKey] = struct{}{}
		for domainIndex, domain := range department.Domains {
			if _, exists := activeNamespaces[domain]; !exists {
				errorsByField[fmt.Sprintf("departments.%d.domains.%d", departmentIndex, domainIndex)] =
					fmt.Sprintf("department domain %q does not match an active runtime registry tool namespace", domain)
			}
		}
	}

	costCentreCodes := map[string]struct{}{}
	for index, costCentre := range profile.CostCentres {
		codeKey := strings.ToLower(costCentre.Code)
		if costCentre.Code == "" {
			errorsByField[fmt.Sprintf("costCentres.%d.code", index)] = "cost centre code is required"
		} else if _, exists := costCentreCodes[codeKey]; exists {
			errorsByField[fmt.Sprintf("costCentres.%d.code", index)] = fmt.Sprintf("cost centre code %q is duplicated", costCentre.Code)
		}
		costCentreCodes[codeKey] = struct{}{}
		if costCentre.BudgetAmount < 0 {
			errorsByField[fmt.Sprintf("costCentres.%d.budgetAmount", index)] = "budget amount cannot be negative"
		}
		if !validCurrency(costCentre.Currency) {
			errorsByField[fmt.Sprintf("costCentres.%d.currency", index)] =
				fmt.Sprintf("currency %q must be a 3-letter code", costCentre.Currency)
		}
	}

	tierLabels := map[string]struct{}{}
	for index, tier := range profile.ApprovalTiers {
		labelKey := strings.ToLower(tier.Label)
		if tier.Label == "" {
			errorsByField[fmt.Sprintf("approvalTiers.%d.label", index)] = "approval tier label is required"
		} else if _, exists := tierLabels[labelKey]; exists {
			errorsByField[fmt.Sprintf("approvalTiers.%d.label", index)] = fmt.Sprintf("approval tier label %q is duplicated", tier.Label)
		}
		tierLabels[labelKey] = struct{}{}
		if tier.MaxAmount < 0 {
			errorsByField[fmt.Sprintf("approvalTiers.%d.maxAmount", index)] = "approval tier maximum cannot be negative"
		}
		if index > 0 && tier.MaxAmount <= profile.ApprovalTiers[index-1].MaxAmount {
			errorsByField[fmt.Sprintf("approvalTiers.%d.maxAmount", index)] =
				fmt.Sprintf("approval tier %q overlaps or is not sorted after %q", tier.Label, profile.ApprovalTiers[index-1].Label)
		}
	}
	return errorsByField
}

func ActiveNamespaces(tools []registry.Tool) map[string]struct{} {
	namespaces := map[string]struct{}{}
	for _, tool := range tools {
		if !strings.EqualFold(strings.TrimSpace(tool.Status), "active_mcp_schema_present") {
			continue
		}
		namespace := ToolNamespace(tool)
		if namespace != "" {
			namespaces[namespace] = struct{}{}
		}
	}
	return namespaces
}

func ToolNamespace(tool registry.Tool) string {
	if module := strings.ToLower(strings.TrimSpace(tool.Module)); module != "" {
		return module
	}
	name := strings.ToLower(strings.TrimSpace(tool.Name))
	if separator := strings.Index(name, "."); separator > 0 {
		return name[:separator]
	}
	return name
}

func DomainList(namespaces map[string]struct{}) []string {
	out := make([]string, 0, len(namespaces))
	for namespace := range namespaces {
		out = append(out, namespace)
	}
	sort.Strings(out)
	return out
}

func IsZero(profile Profile) bool {
	return profile.Name == "" &&
		profile.LegalName == "" &&
		profile.Industry == "" &&
		profile.Timezone == "" &&
		profile.Currency == "" &&
		profile.FiscalYearStart == "" &&
		profile.ContactEmail == "" &&
		profile.ERPSystemName == "" &&
		profile.ERPVersion == "" &&
		profile.Notes == "" &&
		len(profile.Departments) == 0 &&
		len(profile.CostCentres) == 0 &&
		len(profile.ApprovalTiers) == 0
}

func validCurrency(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, character := range value {
		if character < 'A' || character > 'Z' {
			return false
		}
	}
	return true
}

func normalizeDomains(domains []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(domains))
	for _, domain := range domains {
		domain = strings.ToLower(strings.TrimSpace(domain))
		if domain == "" {
			continue
		}
		if _, exists := seen[domain]; exists {
			continue
		}
		seen[domain] = struct{}{}
		out = append(out, domain)
	}
	sort.Strings(out)
	return out
}
