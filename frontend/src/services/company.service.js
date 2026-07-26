import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const companyService = {
  async get() {
    return unwrap(await apiClient.get("/company"), {});
  },
  async update(profile) {
    return unwrap(await apiClient.put("/company", profile), {});
  },
  async createDepartment(department) {
    return unwrap(await apiClient.post("/company/departments", department), {});
  },
  async updateDepartment(id, department) {
    return unwrap(await apiClient.put(`/company/departments/${encodeURIComponent(id)}`, department), {});
  },
  async deleteDepartment(id) {
    return unwrap(await apiClient.delete(`/company/departments/${encodeURIComponent(id)}`), {});
  },
  async createCostCentre(costCentre) {
    return unwrap(await apiClient.post("/company/cost-centres", costCentre), {});
  },
  async updateCostCentre(code, costCentre) {
    return unwrap(await apiClient.put(`/company/cost-centres/${encodeURIComponent(code)}`, costCentre), {});
  },
  async deleteCostCentre(code) {
    return unwrap(await apiClient.delete(`/company/cost-centres/${encodeURIComponent(code)}`), {});
  },
  async createApprovalTier(tier) {
    return unwrap(await apiClient.post("/company/approval-tiers", tier), {});
  },
  async updateApprovalTier(label, tier) {
    return unwrap(await apiClient.put(`/company/approval-tiers/${encodeURIComponent(label)}`, tier), {});
  },
  async deleteApprovalTier(label) {
    return unwrap(await apiClient.delete(`/company/approval-tiers/${encodeURIComponent(label)}`), {});
  },
};

export default companyService;
