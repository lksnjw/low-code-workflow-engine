import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const companyService = {
/*******************************************************************************
 * Function: get
 *
 * Gets the application for the company service module.
 ******************************************************************************/
  async get() {
    return unwrap(await apiClient.get("/company"), {});
  },
/*******************************************************************************
 * Function: update
 *
 * Updates the application for the company service module.
 ******************************************************************************/
  async update(profile) {
    return unwrap(await apiClient.put("/company", profile), {});
  },
/*******************************************************************************
 * Function: createDepartment
 *
 * Creates department for the company service module.
 ******************************************************************************/
  async createDepartment(department) {
    return unwrap(await apiClient.post("/company/departments", department), {});
  },
/*******************************************************************************
 * Function: updateDepartment
 *
 * Updates department for the company service module.
 ******************************************************************************/
  async updateDepartment(id, department) {
    return unwrap(await apiClient.put(`/company/departments/${encodeURIComponent(id)}`, department), {});
  },
/*******************************************************************************
 * Function: deleteDepartment
 *
 * Deletes department for the company service module.
 ******************************************************************************/
  async deleteDepartment(id) {
    return unwrap(await apiClient.delete(`/company/departments/${encodeURIComponent(id)}`), {});
  },
/*******************************************************************************
 * Function: createCostCentre
 *
 * Creates cost centre for the company service module.
 ******************************************************************************/
  async createCostCentre(costCentre) {
    return unwrap(await apiClient.post("/company/cost-centres", costCentre), {});
  },
/*******************************************************************************
 * Function: updateCostCentre
 *
 * Updates cost centre for the company service module.
 ******************************************************************************/
  async updateCostCentre(code, costCentre) {
    return unwrap(await apiClient.put(`/company/cost-centres/${encodeURIComponent(code)}`, costCentre), {});
  },
/*******************************************************************************
 * Function: deleteCostCentre
 *
 * Deletes cost centre for the company service module.
 ******************************************************************************/
  async deleteCostCentre(code) {
    return unwrap(await apiClient.delete(`/company/cost-centres/${encodeURIComponent(code)}`), {});
  },
/*******************************************************************************
 * Function: createApprovalTier
 *
 * Creates approval tier for the company service module.
 ******************************************************************************/
  async createApprovalTier(tier) {
    return unwrap(await apiClient.post("/company/approval-tiers", tier), {});
  },
/*******************************************************************************
 * Function: updateApprovalTier
 *
 * Updates approval tier for the company service module.
 ******************************************************************************/
  async updateApprovalTier(label, tier) {
    return unwrap(await apiClient.put(`/company/approval-tiers/${encodeURIComponent(label)}`, tier), {});
  },
/*******************************************************************************
 * Function: deleteApprovalTier
 *
 * Deletes approval tier for the company service module.
 ******************************************************************************/
  async deleteApprovalTier(label) {
    return unwrap(await apiClient.delete(`/company/approval-tiers/${encodeURIComponent(label)}`), {});
  },
};

export default companyService;
