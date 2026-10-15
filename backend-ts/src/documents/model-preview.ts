import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { requestedModel, selectProvider } from "../http/handlers/model-selection.js";
import { promptData } from "../prompts/contracts.js";
import { OpenAICompatibleError } from "../providers/openai-compatible.js";
import type { ProviderInvocationContext } from "../analysisprovider/types.js";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const value = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
const fields = z.record(z.string().min(1).max(80), value).refine(row => Object.keys(row).length <= 50);
const previewSchema = z.object({ documentType: z.string().max(128), summary: z.string().max(1500), fields,
  rows: z.array(fields).max(50).optional(), missingInformation: z.array(z.string().max(300)).max(20),
  warnings: z.array(z.string().max(300)).max(20) }).strict();

/** Ephemeral interpretation, independent of pipeline availability. No durable
 * source receipt, schema association, tool authority or storage is created. */
export async function previewDocument(services: HandlerServices, user: CurrentUser, sessionId: string,
  source: { bytes: Buffer; filename: string }, body: { model?: string; instruction?: string }, signal?: AbortSignal) {
  const provider = selectProvider(services, requestedModel(body.model));
  if (!provider?.configured) throw new HandlerFailure(503, "Configure a model before preparing a document preview", { code: "PROVIDER_NOT_CONFIGURED" });
  provider.assertEgress({ purpose: "interactive", dataClass: "restricted" });
  if (!source.bytes.length || source.bytes.length > MAX_SOURCE_BYTES) throw new HandlerFailure(413, "Model preview requires a non-empty file up to 4 MiB", { code: "DOCUMENT_PREVIEW_LIMIT" });
  if (body.instruction && body.instruction.length > 2000) throw new HandlerFailure(422, "Keep the document request within 2000 characters");
  const digest = createHash("sha256").update(source.bytes).digest("hex");
  let attachment: ProviderInvocationContext["documentAttachment"], text = "";
  const ext = source.filename.toLowerCase().split(".").at(-1);
  const mime = ext === "pdf" && source.bytes.subarray(0, 5).toString() === "%PDF-" ? "application/pdf"
    : ext === "png" && source.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : ["jpg", "jpeg"].includes(ext ?? "") && source.bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg" : null;
  if (mime) {
    if (mime === "application/pdf" && provider.configuration?.baseURL.replace(/\/+$/, "") !== "https://openrouter.ai/api/v1")
      throw new HandlerFailure(422, "This provider has no configured native PDF preview. Wait for OCR or choose a supported model.", { code: "DOCUMENT_PREVIEW_UNSUPPORTED" });
    attachment = { filename: `attachment.${ext}`, mimeType: mime, dataBase64: source.bytes.toString("base64"), sha256: digest };
  } else if (["txt", "csv", "tsv", "json"].includes(ext ?? "")) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes); } catch { throw new HandlerFailure(422, "Model text preview requires UTF-8 text", { code: "DOCUMENT_PREVIEW_UNSUPPORTED" }); }
    if (!text.trim() || text.includes("\0")) throw new HandlerFailure(422, "No readable text is available for preview", { code: "DOCUMENT_PREVIEW_UNSUPPORTED" });
  } else throw new HandlerFailure(422, "Model-only preview supports valid PDF, PNG, JPEG and UTF-8 text/CSV/TSV/JSON files. Other formats still need the pipeline.", { code: "DOCUMENT_PREVIEW_UNSUPPORTED" });
  let response;
  try {
    response = await provider.generate(promptData({ request: body.instruction || "Read this business document and identify its fields for review.",
      source: { sha256: digest, pipelineReceipt: false, ocrConfirmed: false, text: text.slice(0, 24000), partialText: text.length > 24000 },
      output: { documentType: "observed business document type, or unknown", summary: "brief observed content only", fields: "single form: observed fields; empty for batch",
        rows: "optional ordered source rows, max 50; never invent or silently discard rows", missingInformation: ["uncertain values or required information that cannot be established"], warnings: ["unreadable/partial/ambiguous source limits"] } }),
      "prompt/document-preview/v1", signal, "", { actor: { id: user.id, role: user.role }, sessionId, maxOutputTokens: 4096,
        ...(attachment ? { documentAttachment: attachment } : {}), egress: { purpose: "interactive", dataClass: "restricted" } });
  } catch (error) {
    if (error instanceof OpenAICompatibleError && [400, 415, 422].includes(error.statusCode ?? 0))
      throw new HandlerFailure(422, "The selected model cannot preview this file. No alternative model was used. Wait for OCR or choose a compatible model.", { code: "DOCUMENT_PREVIEW_UNSUPPORTED" });
    throw error;
  }
  let preview: z.infer<typeof previewSchema>;
  try {
    if (Buffer.byteLength(response.text) > 48000) throw new Error("preview limit");
    preview = previewSchema.parse(JSON.parse(response.text));
  } catch { throw new HandlerFailure(422, "The model did not return a valid bounded preview. Nothing was confirmed or stored.", { code: "DOCUMENT_PREVIEW_INVALID" }); }
  return { ...preview, status: "MODEL_PREVIEW", model: response.model, sourceContentHash: digest, requiresHumanReview: true,
    pipelineStorageConfirmed: false, vectorIndexConfirmed: false, ocrConfirmed: false, erpChanged: false,
    ...(text.length > 24000 ? { warnings: [...preview.warnings, "Partial preview: only the first 24000 text characters were supplied."] } : {}) };
}

export async function readPreviewUpload(request: FastifyRequest) {
  if (!request.isMultipart()) throw new HandlerFailure(422, "Choose a file for model preview");
  let source: { bytes: Buffer; filename: string } | undefined;
  const body: { model?: string; instruction?: string } = {};
  for await (const part of request.parts({ limits: { fileSize: MAX_SOURCE_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 8192 } })) {
    if (part.type === "file") {
      if (source || part.fieldname !== "file") throw new HandlerFailure(422, "Exactly one file is required for preview");
      source = { bytes: await part.toBuffer(), filename: part.filename };
    } else {
      if (!["model", "instruction"].includes(part.fieldname) || Object.hasOwn(body, part.fieldname) || part.valueTruncated)
        throw new HandlerFailure(422, "Invalid model preview fields");
      const field = part.fieldname as keyof typeof body;
      body[field] = typeof part.value === "string" ? part.value.trim() : "";
    }
  }
  if (!source) throw new HandlerFailure(422, "Choose one file for preview");
  return { source, body };
}
