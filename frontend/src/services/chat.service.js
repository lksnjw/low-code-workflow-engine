import { apiClient } from "../config/axios";
import { appConfig } from "../config/app";

export const chatService = {
  async capabilities() {
    const response = await apiClient.get("/chat/capabilities");
    return response.data.data;
  },
  async models(options = {}) {
    const response = await apiClient.get("/chat/models", options);
    return response.data.data;
  },
  async operations(sessionId, options = {}) {
    const response = await apiClient.get(`/chat/sessions/${sessionId}/operations`, options);
    return response.data.data ?? [];
  },
  async operation(id, after = 0, options = {}) {
    const { waitMs, ...requestOptions } = options;
    const response = await apiClient.get(`/chat/operations/${id}`, { params: { after, ...(waitMs === undefined ? {} : { waitMs }) }, ...requestOptions });
    return response.data.data;
  },
  async cancelOperation(id) {
    const response = await apiClient.post(`/chat/operations/${id}/cancel`, {});
    return response.data.data;
  },
/*******************************************************************************
 * Function: listSessions
 *
 * Lists sessions for the chat service module.
 ******************************************************************************/
  async listSessions({ includePageMetadata = false, ...options } = {}) {
    const response = await apiClient.get("/chat/sessions", options);
    const items = response.data.data ?? [];
    return includePageMetadata ? { items, meta: response.data.meta } : items;
  },

/*******************************************************************************
 * Function: createSession
 *
 * Creates session for the chat service module.
 ******************************************************************************/
  async createSession(title = "Workflow conversation", options = {}) {
    const response = await apiClient.post("/chat/sessions", { title, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
    return response.data.data;
  },

/*******************************************************************************
 * Function: getSession
 *
 * Gets session for the chat service module. Paginated — defaults to the
 * most recent `limit` messages; pass `before` (a message id) to page
 * further back in history instead of loading the whole conversation.
 ******************************************************************************/
  async getSession(sessionId, { limit, before, signal } = {}) {
    const params = {};
    if (limit) params.limit = limit;
    if (before) params.before = before;
    const response = await apiClient.get(`/chat/sessions/${sessionId}`, { params, signal });
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
    ["mode", "model", "delivery", "idempotencyKey"].forEach((key) => {
      if (options[key]) payload[key] = options[key];
    });
    if (options.workflowContext) payload.workflowContext = options.workflowContext;
    if (options.documentContext) payload.documentContext = options.documentContext;
    if (options.attachmentTicket) payload.attachmentTicket = options.attachmentTicket;
    if (options.nodeContext) payload.nodeContext = options.nodeContext;
    if (options.requestRevision) payload.requestRevision = options.requestRevision;
    if (options.emailDraftCommand) payload.emailDraftCommand = options.emailDraftCommand;
    if (options.emailDeliveryCommand) payload.emailDeliveryCommand = options.emailDeliveryCommand;
    // Read loops can use multiple provider turns. Draft edits themselves do
    // not invoke a provider or dispatch an ERP/email operation.
    const response = await apiClient.post(`/chat/sessions/${sessionId}/messages`, payload, { timeout: options.delivery === "async-chat" ? appConfig.apiRequestTimeoutMs : 300000 });
    return response.data.data;
  },
};
