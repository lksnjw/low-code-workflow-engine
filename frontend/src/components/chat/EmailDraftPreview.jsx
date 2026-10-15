import { useId, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { chatService } from "../../services/chat.service";

const reportLabels = { NOT_PREPARED: "Report not prepared", PARTIAL: "Report incomplete", PREPARED_FOR_REVIEW: "Report draft · review required", USER_EDITED: "Edited draft · review required" };
const reasonLabels = { ERPBRIDGE_NOT_CONNECTED: "ERPBridge is not connected. No report was retrieved.", PROVIDER_NOT_CONFIGURED: "The analysis provider is not configured.", NO_ADMITTED_READ_TOOLS: "No permitted, verified read tools are available.", REPORT_PREPARATION_FAILED: "Report preparation failed. No complete report was saved.", NO_CONFIRMED_READ: "No confirmed ERP data was retrieved." };

// This is a draft editor, not a send/approval control. Server revisions and
// ownership remain authoritative; uncertain saves require a conversation reload.
export default function EmailDraftPreview({ draft: initialDraft, emailDelivery: initialDelivery, reportReason, superseded = false, onSaved, onContinue, busy = false }) {
  const { user } = useAuth();
  const id = useId();
  const savingRef = useRef(false);
  const [draft, setDraft] = useState(initialDraft);
  const [fields, setFields] = useState({ to: initialDraft.to, subject: initialDraft.subject, body: initialDraft.body });
  const [status, setStatus] = useState("idle");
  const [notice, setNotice] = useState("");
  const [sharingConfirmed, setSharingConfirmed] = useState(false);
  const [delivery, setDelivery] = useState(initialDelivery ?? null);
  const shownDraft = superseded ? initialDraft : draft;
  const shownFields = superseded ? initialDraft : fields;
  const canEdit = !superseded && !delivery && user?.id === draft.ownerId && draft.profile === "email-draft-v1" && draft.state === "DRAFT_NOT_SENT";
  const locked = !canEdit || busy || ["saving", "preparing", "requesting", "uncertain", "conflict"].includes(status);
  const exactSavedDraft = fields.to === draft.to && fields.subject === draft.subject && fields.body === draft.body;
  const canRequest = canEdit && !draft.recurring && exactSavedDraft && Boolean(draft.to && draft.subject.trim() && draft.body.trim()) && sharingConfirmed &&
    !busy && !["saving", "preparing", "requesting", "uncertain", "conflict"].includes(status);
  const continueInChat = async () => {
    if (locked || !exactSavedDraft || !onContinue || savingRef.current) return;
    savingRef.current = true; setStatus("preparing"); setNotice("");
    try {
      const result = await onContinue(`Help me prepare this email: ${draft.originalRequest || "Retrieve the details needed for this email."}\nUse the current recipient${draft.to ? ` ${draft.to}` : " once I confirm their address"}, not a different address from an earlier draft. Prepare the details and show the exact email for my confirmation. Do not send it yet.`);
      if (!result) throw new Error("Chat admission not confirmed");
      setStatus("preparation-requested"); setNotice("Preparation requested in chat. Check its progress and answer any missing-detail question. Nothing was sent by this button.");
    } catch {
      setStatus("uncertain"); setNotice("Preparation acknowledgement is unconfirmed. Check this conversation's saved progress before requesting it again.");
    } finally { savingRef.current = false; }
  };
  const save = async (event) => {
    event.preventDefault();
    if (locked || savingRef.current) return;
    savingRef.current = true; setStatus("saving"); setNotice("");
    try {
      const result = await chatService.sendMessage(draft.sessionId, "Save email draft changes", { emailDraftCommand: {
        draftId: draft.id, baseVersion: draft.version, baseHash: draft.contentHash, commandId: crypto.randomUUID(), patch: fields,
      } });
      const saved = result?.assistantMessage?.artifacts?.emailDraft;
      if (!saved || saved.id !== draft.id || saved.sessionId !== draft.sessionId || saved.version !== draft.version + 1 || saved.state !== "DRAFT_NOT_SENT") {
        setStatus("uncertain"); setNotice("Save confirmation is uncertain. Reload this conversation to check the saved draft before editing again."); return;
      }
      setDraft(saved); setFields({ to: saved.to, subject: saved.subject, body: saved.body }); setStatus("saved"); setNotice("Draft changes saved. Nothing sent or approved.");
      try { await onSaved?.(); } catch { setNotice("Draft changes saved. Nothing sent or approved. Conversation refresh failed; reload to see the saved revision."); }
    } catch (error) {
      if (error?.response?.status === 409) { setStatus("conflict"); setNotice("This draft changed elsewhere. Reload the conversation before editing again."); }
      else if (!error?.response || error.response.status >= 500) { setStatus("uncertain"); setNotice("Save confirmation is uncertain. Reload this conversation to check the saved draft before editing again."); }
      else { setStatus("error"); setNotice("Changes were not accepted. Check your recipient and access, then try saving again."); }
    } finally { savingRef.current = false; }
  };
  const requestApproval = async () => {
    if (!canRequest || savingRef.current) return;
    savingRef.current = true; setStatus("requesting"); setNotice("");
    try {
      const result = await chatService.sendMessage(draft.sessionId, "Request independent approval for this exact email draft", { emailDeliveryCommand: {
        profile: "email-delivery-admission-command/v1", draftId: draft.id, baseVersion: draft.version, baseHash: draft.contentHash,
        idempotencyKey: crypto.randomUUID(), sharingConfirmed: true,
      } });
      const receipt = result?.emailDelivery ?? result?.assistantMessage?.artifacts?.emailDelivery;
      if (!receipt || receipt.profile !== "email-delivery-admission/v1" || receipt.draftId !== draft.id || receipt.draftVersion !== draft.version ||
          receipt.draftHash !== draft.contentHash || !receipt.workflowId || !receipt.executionId || receipt.reviewRequested !== true || receipt.deliveryVerified !== false) {
        setStatus("uncertain"); setNotice("Approval-request confirmation is uncertain. Reload the conversation before taking another action."); return;
      }
      setDelivery(receipt); setStatus("requested"); setNotice("Independent approval requested for this exact draft. Nothing has been sent.");
      try { await onSaved?.(); } catch { setNotice("Approval was requested, but conversation refresh failed. Nothing is labeled as sent; reload to inspect the execution."); }
    } catch (error) {
      if (error?.response?.status === 409) { setStatus("conflict"); setNotice("This draft or its approval request changed. Reload the conversation before taking another action."); }
      else if (!error?.response || error.response.status >= 500) { setStatus("uncertain"); setNotice("Approval-request confirmation is uncertain. Reload the conversation; do not create a new request."); }
      else { setStatus("error"); setNotice(error?.response?.data?.message ?? "Approval was not requested. Check connector readiness, access and the exact saved draft."); }
    } finally { savingRef.current = false; }
  };
  return <section aria-label="Email draft" className="mt-4 min-w-0 border-t border-gray-200 pt-3 dark:border-gray-700">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Email draft</h3>
      <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">{delivery ? "Approval requested · not sent" : "Not sent"} · revision {shownDraft.version}</span>
    </div>
    <p className="mt-1 text-xs text-gray-500">{reportLabels[shownDraft.reportStatus] ?? "Review required"}{shownDraft.recurring ? " · no schedule active" : ""}</p>
    {shownDraft.recipientResolution?.status === "RESOLVED" && <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
      Recipient resolved from the company directory: {shownDraft.recipientResolution.userName}. The exact address remains editable and will be rechecked before approval admission.
    </p>}
    {shownDraft.recipientReference && shownDraft.recipientResolution?.status !== "RESOLVED" && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
      Could not safely resolve “{shownDraft.recipientReference}”: {shownDraft.recipientResolution?.reason ?? "confirm one exact address."}
    </p>}
    {shownDraft.reportStatus === "NOT_PREPARED" && reasonLabels[reportReason] && <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{reasonLabels[reportReason]}</p>}
    {canEdit && !shownDraft.recurring && onContinue && <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs">
      <p>The assistant can retrieve the missing details and prepare the message here. If the order type or another required detail is unclear, answer its question in chat.</p>
      <button type="button" disabled={locked || !exactSavedDraft} onClick={continueInChat} className="mt-2 rounded-md bg-primary px-3 py-2 font-semibold text-white disabled:opacity-50">{status === "preparing" ? "Preparing in chat…" : "Prepare email with assistant"}</button>
      {!exactSavedDraft && <p className="mt-2">Save your edits before continuing in chat.</p>}
    </div>}
    <form onSubmit={save} className="mt-3 space-y-3">
      <div><label htmlFor={`${id}-to`} className="text-xs font-medium text-gray-600 dark:text-gray-300">Recipient email</label>
        <input id={`${id}-to`} type="email" maxLength={254} value={shownFields.to} disabled={locked} placeholder="Confirm one exact address"
          onChange={(e) => setFields({ ...fields, to: e.target.value })} className="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm dark:border-gray-700" /></div>
      <div><label htmlFor={`${id}-subject`} className="text-xs font-medium text-gray-600 dark:text-gray-300">Subject</label>
        <input id={`${id}-subject`} maxLength={300} value={shownFields.subject} disabled={locked}
          onChange={(e) => setFields({ ...fields, subject: e.target.value })} className="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm dark:border-gray-700" /></div>
      <div><label htmlFor={`${id}-body`} className="text-xs font-medium text-gray-600 dark:text-gray-300">Message draft</label>
        <textarea id={`${id}-body`} rows={7} maxLength={32000} value={shownFields.body} disabled={locked} placeholder="No complete report yet. Add a message or resolve the missing report details."
          onChange={(e) => setFields({ ...fields, body: e.target.value })} className="mt-1 w-full resize-y rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm leading-6 dark:border-gray-700" />
        <span className="text-xs text-gray-400">{shownFields.body.length.toLocaleString()} / 32,000 characters</span></div>
      {canEdit && <button type="submit" disabled={locked} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50">{status === "saving" ? "Saving draft…" : "Save draft changes"}</button>}
      {canEdit && !shownDraft.recurring && <div className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-200"><input type="checkbox" checked={sharingConfirmed} onChange={(event) => setSharingConfirmed(event.target.checked)} />
          <span>I confirm this exact recipient and message may be shared through the reviewed ERPBridge email connector.</span></label>
        {!exactSavedDraft && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Save these edits before requesting approval.</p>}
        <button type="button" disabled={!canRequest} onClick={requestApproval} className="mt-3 rounded-md border border-primary px-3 py-2 text-xs font-semibold text-primary disabled:opacity-50">
          {status === "requesting" ? "Requesting approval…" : "Request independent approval"}</button>
        <p className="mt-2 text-xs text-gray-500">This queues review only. A separate authorized reviewer must approve the exact operation before SDK dispatch.</p>
      </div>}
      {canEdit && shownDraft.recurring && <p className="text-xs text-amber-700 dark:text-amber-300">Recurring delivery must be created and reviewed as a scheduled workflow. This chat draft cannot activate a schedule.</p>}
      {!canEdit && !delivery && <p className="text-xs text-gray-500">{superseded ? "Historical draft. Edit the newest version below, or reload the conversation." : "Only this conversation’s owner can edit the draft."}</p>}
      {delivery && <div className="rounded-md border border-gray-200 p-3 text-xs dark:border-gray-700">
        <p className="font-semibold text-gray-800 dark:text-gray-100">Independent review requested. No delivery is verified.</p>
        <p className="mt-1 text-gray-600 dark:text-gray-300">Current saved state: {delivery.status}. ERPBridge acceptance, if it later occurs, is not an email delivery receipt.</p>
        <a className="mt-2 inline-block font-semibold text-primary hover:underline" href={`/executions/${encodeURIComponent(delivery.executionId)}`}>Open governed execution</a>
      </div>}
      {notice && <p role={["saved", "requested", "preparation-requested"].includes(status) ? "status" : "alert"} className="text-xs text-gray-600 dark:text-gray-300">{notice}</p>}
    </form>
    <details className="mt-3 text-xs text-gray-600 dark:text-gray-300">
      <summary className="cursor-pointer py-1">Before sending · {shownDraft.sourceEvidence?.length ?? 0} confirmed reads</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">{shownDraft.requirements?.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul>
      <p className="mt-2">Confirmed reads show retrieval succeeded, not that the analysis is complete or every sentence is verified. Review facts, reporting period and sharing permission. Editing never creates approval or a delivery receipt.</p>
    </details>
  </section>;
}
