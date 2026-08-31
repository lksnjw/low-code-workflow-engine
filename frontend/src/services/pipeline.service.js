const BASE = "/api/pipeline";
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "partial", "interrupted"]);

/*******************************************************************************
 * Function: parseJsonResponse
 *
 * Parses a fetch Response as JSON and throws the API's own error envelope
 * ({ error: { code, message, request_id, details } }) on a non-2xx status,
 * instead of a generic fetch/HTTP error.
 ******************************************************************************/
async function parseJsonResponse(response) {
  const result = await response.json().catch(() => null);
  if (!response.ok) throw result ?? { error: { code: "UNKNOWN", message: `Request failed with status ${response.status}` } };
  return result;
}

export const pipelineService = {
/*******************************************************************************
 * Function: uploadCsv
 *
 * Uploads a CSV/TSV/TXT file to the schema-indexing pipeline. multipart/
 * form-data only — never set Content-Type manually, the browser generates
 * the boundary.
 ******************************************************************************/
  async uploadCsv(file) {
    const payload = new FormData();
    payload.append("file", file);
    const response = await fetch(`${BASE}/v1/files/csv`, { method: "POST", body: payload });
    return parseJsonResponse(response);
  },

/*******************************************************************************
 * Function: uploadDocument
 *
 * Uploads a PDF/image file, plus optional identity metadata (source system,
 * entity, business key, document type, sensitivity) that isn't inferred
 * from the filename.
 ******************************************************************************/
  async uploadDocument(file, metadata = {}) {
    const payload = new FormData();
    payload.append("file", file);
    for (const [name, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null && value !== "") payload.append(name, value);
    }
    const response = await fetch(`${BASE}/v1/files/documents`, { method: "POST", body: payload });
    return parseJsonResponse(response);
  },

/*******************************************************************************
 * Function: getJob
 *
 * Fetches the current status of a schema-indexing or document-indexing job.
 ******************************************************************************/
  async getJob(jobId) {
    const response = await fetch(`${BASE}/v1/jobs/${encodeURIComponent(jobId)}`);
    return parseJsonResponse(response);
  },

/*******************************************************************************
 * Function: waitForJob
 *
 * Polls a job until it reaches a terminal state (succeeded / failed /
 * partial / interrupted), or the abort signal fires. Calls onTick with each
 * intermediate job snapshot so the caller can render live progress.
 ******************************************************************************/
  async waitForJob(jobId, { intervalMs = 1500, onTick, signal } = {}) {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Polling aborted", "AbortError");
      const job = await this.getJob(jobId);
      onTick?.(job);
      if (TERMINAL_JOB_STATES.has(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
};

export default pipelineService;
