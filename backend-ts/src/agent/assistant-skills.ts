/** Release-owned skills guide the agent's planning, never its authority.
 * The model selects a skill/tool; backend handlers validate every effect. */
export const ASSISTANT_SKILLS = [
  {
    id: "document-intake",
    when: "A user attaches an image, PDF, spreadsheet or form.",
    instructions:
      "Use the attachment review controls. Extract with the selected model when available; OCR/indexing may continue separately. A preview is not a storage receipt. Ask for missing mandatory fields and confirm reviewed values before saving. Do not claim an ERP record was created from an upload.",
  },
  {
    id: "document-retrieval",
    when: "Find or analyse a previously saved document or registration.",
    instructions:
      "Use erp_tool_catalog with skill=documents to find document capabilities without ERP discovery, or fetch the exact pipeline-library-discover/search/resolve schema directly. Use discover for permitted schema/collection summaries, search for relevant document identifiers, then resolve for current text and reviewed fields. These are direct backend skills, independent of ERPBridge. Do not infer current storage from chat memory. Never ask the user for a service token, technical collection or tool name.",
  },
  {
    id: "policy-checking",
    when: "Policy switches require request or transaction validation.",
    instructions:
      "The backend runs RAG directly when configured and independently supports the local JSON/model switch. Wait for its decision; never override deny or review. A timeout is not approval. These checks do not replace required ERP inputs, access or human confirmation.",
  },
  {
    id: "erp-record-actions",
    when: "Look up, register or update a business record, or send a notification.",
    instructions:
      "Discover the real ERPBridge catalog and exact schema. The user describes the outcome in ordinary language. Check required fields, exact identifiers and duplicates. Prepare changes for confirmation; do not write from an attachment or historical receipt without the current exact proposal.",
  },
  {
    id: "professional-email",
    when: "Prepare an outgoing email, notification or report for review.",
    instructions:
      "Compose the actual outgoing message, not just a nicely formatted chat reply. Use confirmed results and preserve scope/coverage notes. Write a clear subject, short introduction, descriptive ## section headings, and compact Markdown pipe tables with a header/separator row for tabular records. Put totals, currencies and missing values exactly as evidenced; do not invent totals or assume a page is complete. Do not align columns with spaces. Inspect the current email contract: when text and html fields are supported, supply the required plain text; the backend will generate its safe branded HTML/logo layout before exact confirmation. Never guess a logo URL, inject tracking images, write scripts, remove the text alternative or put HTML in a plain-text field. If HTML is not supported, use readable plain text with one record per block. Keep recipients, sender, attachments and send confirmation unchanged. Never claim inbox delivery from a send acceptance.",
  },
  {
    id: "workflow-automation",
    when: "The user explicitly asks to create, edit, run or schedule a workflow.",
    instructions:
      "Use the workflow authoring/control route. A normal lookup does not create a workflow. Persist a reviewed source snapshot, not expiring document credentials. Scheduling, publication, approval and execution need separate backend receipts; never claim completion from a draft.",
  },
] as const;
export const BACKEND_ASSISTANT_SKILL_GUIDANCE =
  "\nBACKEND AGENT SKILLS\n" +
  ASSISTANT_SKILLS.map(
    (skill) => `${skill.id}: ${skill.when} ${skill.instructions}`
  ).join("\n");
