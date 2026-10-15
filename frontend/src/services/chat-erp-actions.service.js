import { apiClient } from "../config/axios";

const path = action => `/chat/sessions/${encodeURIComponent(action.sessionId)}/erp-actions/${encodeURIComponent(action.id)}`;
export const chatErpActionsService = {
  async get(action) { return (await apiClient.get(path(action))).data.data; },
  // Explicit one-shot confirmation; transport failures must not replay writes.
  async execute(action, decisionKey) {
    return (await apiClient.post(path(action), { reviewHash: action.reviewHash, decisionKey }, { timeout: 120000 })).data.data;
  },
};
