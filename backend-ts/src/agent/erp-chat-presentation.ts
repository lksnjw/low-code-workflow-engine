/** Graphs remain optional grounded read presentations, never action receipts. */
export function erpChatPresentation(text: string, hasConfirmedReads: boolean, blocked: boolean, hasProposal: boolean) {
  const raw = /<vis>([\s\S]*?)<\/vis>/i.exec(text)?.[1];
  let visualisation;
  if (raw && raw.length <= 32_000 && hasConfirmedReads && !blocked && !hasProposal) {
    try {
      const value = JSON.parse(raw);
      if (value && ["bar", "line", "pie", "table"].includes(value.type) && typeof value.title === "string" && value.title.length <= 300 &&
          Array.isArray(value.data) && value.data.length > 0 && value.data.length <= 100 && value.data.every((row: unknown) =>
            row !== null && typeof row === "object" && typeof (row as Record<string, unknown>).label === "string" &&
            typeof (row as Record<string, unknown>).value === "number" && Number.isFinite((row as Record<string, unknown>).value))) visualisation = value;
    } catch { /* Malformed chart markup is not a user-visible data result. */ }
  }
  const content = text.replace(/<vis>[\s\S]*?<\/vis>/gi, "").trim();
  const unsupportedEffect = /\b(?:i|we|i've|we've|i have|we have)\s+(?:successfully\s+)?(?:sent|emailed|scheduled|paid|created|updated|deleted|approved|submitted)\b/i.test(content);
  return { text: !hasProposal && unsupportedEffect ? "The reply claimed a change that this request did not execute. Check the recorded ERP responses below; no new change is confirmed by this reply." : content,
    ...(visualisation && !unsupportedEffect ? { visualisation } : {}) };
}
