import { apiClient } from "../config/axios";

export const chatService = {
  async listSessions() {
    const response = await apiClient.get("/chat/sessions");
    return response.data.data ?? [];
  },

  async createSession(title = "Workflow conversation") {
    const response = await apiClient.post("/chat/sessions", { title });
    return response.data.data;
  },

  async getSession(sessionId) {
    const response = await apiClient.get(`/chat/sessions/${sessionId}`);
    return response.data.data;
  },

  async updateSession(sessionId, title) {
    const response = await apiClient.patch(`/chat/sessions/${sessionId}`, { title });
    return response.data.data;
  },

  async deleteSession(sessionId) {
    const response = await apiClient.delete(`/chat/sessions/${sessionId}`);
    return response.data.data;
  },

  async sendMessage(sessionId, content, options = {}) {
    const payload = { content };
    ["mode", "model"].forEach((key) => {
      if (options[key]) payload[key] = options[key];
    });
    // Workflow synthesis can take up to 60s on the LLM side plus narrative generation.
    const response = await apiClient.post(`/chat/sessions/${sessionId}/messages`, payload, { timeout: 120000 });
    return response.data.data;
  },
};
