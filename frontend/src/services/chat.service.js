import { apiClient } from "../config/axios";

export const chatService = {
/*******************************************************************************
 * Function: listSessions
 *
 * Lists sessions for the chat service module.
 ******************************************************************************/
  async listSessions() {
    const response = await apiClient.get("/chat/sessions");
    return response.data.data ?? [];
  },

/*******************************************************************************
 * Function: createSession
 *
 * Creates session for the chat service module.
 ******************************************************************************/
  async createSession(title = "Workflow conversation") {
    const response = await apiClient.post("/chat/sessions", { title });
    return response.data.data;
  },

/*******************************************************************************
 * Function: getSession
 *
 * Gets session for the chat service module.
 ******************************************************************************/
  async getSession(sessionId) {
    const response = await apiClient.get(`/chat/sessions/${sessionId}`);
    return response.data.data;
  },

/*******************************************************************************
 * Function: updateSession
 *
 * Updates session for the chat service module.
 ******************************************************************************/
  async updateSession(sessionId, title) {
    const response = await apiClient.patch(`/chat/sessions/${sessionId}`, { title });
    return response.data.data;
  },

/*******************************************************************************
 * Function: deleteSession
 *
 * Deletes session for the chat service module.
 ******************************************************************************/
  async deleteSession(sessionId) {
    const response = await apiClient.delete(`/chat/sessions/${sessionId}`);
    return response.data.data;
  },

/*******************************************************************************
 * Function: sendMessage
 *
 * Performs the send Message operation on message for the chat service module.
 ******************************************************************************/
  async sendMessage(sessionId, content, options = {}) {
    const payload = { content };
    ["mode", "model"].forEach((key) => {
      if (options[key]) payload[key] = options[key];
    });
    if (options.workflowContext) payload.workflowContext = options.workflowContext;
    // Candidate synthesis and the follow-up narrative are separate provider calls.
    // Keep the client alive long enough for both backend stages to complete.
    const response = await apiClient.post(`/chat/sessions/${sessionId}/messages`, payload, { timeout: 180000 });
    return response.data.data;
  },
};
