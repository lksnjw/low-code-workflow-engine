import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const analyticsService = {
/*******************************************************************************
 * Function: load
 *
 * Loads the application for the analytics service module.
 ******************************************************************************/
  async load() {
    const [summary, performance, usage, healing, latency, f1, heatmap, costs] =
      await Promise.all([
        apiClient.get("/analytics/summary"),
        apiClient.get("/analytics/performance"),
        apiClient.get("/analytics/usage"),
        apiClient.get("/analytics/self-healing"),
        apiClient.get("/analytics/latency"),
        apiClient.get("/analytics/f1-score"),
        apiClient.get("/analytics/activity-heatmap"),
        apiClient.get("/analytics/cost-trends"),
      ]);
    return {
      summary: unwrap(summary, {}),
      performance: unwrap(performance, []),
      usage: unwrap(usage, []),
      healing: unwrap(healing, {}),
      latency: unwrap(latency, []),
      f1: unwrap(f1, {}),
      heatmap: unwrap(heatmap, []),
      costs: unwrap(costs, []),
    };
  },
};
