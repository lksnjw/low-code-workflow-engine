import { apiClient } from "../config/axios";
import { formatRelativeTime, unwrap } from "./api";
import { normalizeWorkflow } from "./workflow.service";

export const dashboardService = {
/*******************************************************************************
 * Function: load
 *
 * Loads the application for the dashboard service module.
 ******************************************************************************/
  async load() {
    const [summary, activity, health, workflows] = await Promise.all([
      apiClient.get("/dashboard/summary"),
      apiClient.get("/dashboard/activity"),
      apiClient.get("/dashboard/health"),
      apiClient.get("/dashboard/recent-workflows", { params: { limit: 4 } }),
    ]);
    return {
      metrics: (unwrap(summary, {})?.metrics || []).map((metric) => ({
        ...metric,
        value: metric.formattedValue ?? metric.value,
      })),
      activity: (unwrap(activity, []) || []).map((item) => ({
        ...item,
        meta: formatRelativeTime(item.createdAt),
      })),
      health: unwrap(health, { overall: "unknown", services: [] }),
      workflows: (unwrap(workflows, []) || []).map(normalizeWorkflow),
    };
  },
};
