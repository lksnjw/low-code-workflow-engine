import { apiClient } from "../config/axios";
import { apiErrorMessage } from "./api";

async function request(promise) {
  try { return (await promise).data; }
  catch (error) {
    const failure = new Error(apiErrorMessage(error, "The document operation was not confirmed. Refresh before retrying."));
    failure.code = error?.response?.data?.meta?.code;
    failure.status = error?.response?.status;
    failure.unavailable = !error?.response && error?.code !== "ERR_STALE_AUTHORITY" && (Boolean(error?.request) || error?.code === "ECONNABORTED" || error?.message === "Network Error");
    throw failure;
  }
}
const base = "/pipeline/v1/library";
const attachments = session => `/chat/sessions/${encodeURIComponent(session)}/attachments`;
export const documentWorkspaceService = {
  catalog: () => request(apiClient.get(`${base}/catalog`)),
  inventory: () => request(apiClient.get(`${base}/inventory`)),
  search: query => request(apiClient.post(`${base}/search`, { query, limit: 10 }, { timeout: 20000 })),
  resolve: document_id => request(apiClient.post(`${base}/resolve`, { document_id }, { timeout: 20000 })),
  importSchema: schema => request(apiClient.post(`${base}/catalog`, schema)),
  migrate: body => request(apiClient.post(`${base}/migrate`, body, { timeout: 180000 })),
  list: session => request(apiClient.get(attachments(session))),
  get: (session, id) => request(apiClient.get(`${attachments(session)}/${encodeURIComponent(id)}`)),
  prepare: (session, file, body) => {
    const form = new FormData(); form.append("file", file); form.append("idempotency_key", body.idempotencyKey);
    form.append("instruction", body.instruction); if (body.model) form.append("model", body.model);
    if (body.saveToConversation) form.append("save_to_conversation", "true");
    if (body.schemaId) form.append("schema_id", body.schemaId);
    return request(apiClient.post(`${attachments(session)}/prepare`, form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 180000 }));
  },
  stage: (session, file, key) => {
    const form = new FormData(); form.append("file", file); form.append("idempotency_key", key);
    return request(apiClient.post(attachments(session), form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 180000 }));
  },
  preview: (session, file, body) => {
    const form = new FormData(); form.append("file", file);
    if (body.model) form.append("model", body.model);
    if (body.instruction) form.append("instruction", body.instruction.slice(0, 2000));
    return request(apiClient.post(`${attachments(session)}/preview`, form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 180000 }));
  },
  analyse: (session, id, body) => request(apiClient.post(`${attachments(session)}/${encodeURIComponent(id)}/analyse`, body, { timeout: 180000 })),
  confirm: (session, id, body) => request(apiClient.post(`${attachments(session)}/${encodeURIComponent(id)}/confirm`, body, { timeout: 180000 })),
  recover: (session, id, revision) => request(apiClient.post(`${attachments(session)}/${encodeURIComponent(id)}/recover`, { expected_revision: revision })),
};
