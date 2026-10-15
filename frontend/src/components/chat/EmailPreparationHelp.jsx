import { useRef, useState } from "react";
import { registryService } from "../../services/registry.service";
import { emailSenderOptions } from "./emailSenderOptions";

/** Collect business clarification only; this never confirms or sends an email. */
export default function EmailPreparationHelp({ onContinue, busy = false }) {
  const [open, setOpen] = useState(false), [options, setOptions] = useState(null), [sender, setSender] = useState("");
  const [custom, setCustom] = useState(false), [recipient, setRecipient] = useState(""), [status, setStatus] = useState("idle"), [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const load = async () => {
    setOpen(true);
    if (status !== "idle") return;
    setStatus("loading");
    try {
      const catalog = await registryService.liveTools({ search: "email", limit: "all" });
      const candidates = catalog.tools.filter(tool => tool.effect === "CHANGE_OR_OTHER");
      if (candidates.length > 8) throw new Error("Choose the connector in chat first");
      const details = await Promise.all(candidates.map(tool => registryService.liveTools({ connectionId: catalog.connectionId, toolName: tool.name })));
      const supported = details.map(item => emailSenderOptions(item.tool)).filter(Boolean);
      if (!supported.length) throw new Error("No sender contract");
      // Sending, scheduling and attachment tools can share sender choices.
      // This form only clarifies the sender; the agent still chooses a tool.
      setOptions({ choices: [...new Set(supported.flatMap(item => item.choices))].slice(0, 20), restricted: supported.every(item => item.restricted) }); setStatus("ready");
    } catch { setStatus("ready"); setNotice("Sender choices could not be loaded. Enter the full sender address, or ask your administrator which sender to use."); }
  };
  const prepare = async event => {
    event.preventDefault();
    if (busy || inFlight.current || !sender.trim() || !onContinue || options?.restricted && !options.choices.includes(sender)) return;
    inFlight.current = true; setStatus("preparing"); setNotice("");
    try {
      const result = await onContinue(["Continue preparing the email requested in this conversation.", `Use this exact sender address: ${sender.trim()}.`, ...(recipient.trim() ? [`Use this exact recipient address: ${recipient.trim()}.`] : ["Keep the recipient from my current request; ask me if it is ambiguous."]), "Use the requested order tables or message, not a different older draft. Prepare a new exact email proposal for my review if the recipient or contents changed. Do not send, approve or retry an existing send. Ask only for any remaining required details."].join("\n"));
      if (!result) throw new Error("Unconfirmed chat admission");
      setStatus("requested"); setNotice("Details submitted in chat. Wait for the email review card, then review the exact message. This button did not send an email.");
    } catch { setStatus("uncertain"); setNotice("The chat acknowledgement is unconfirmed. Check saved progress before submitting again. No email was sent by this form."); }
    finally { inFlight.current = false; }
  };
  const locked = busy || ["loading", "preparing", "requested", "uncertain"].includes(status);
  return <section aria-label="Email preparation details" className="mt-4 space-y-3 border-l-2 border-primary/30 pl-3 text-xs">
    <p className="font-semibold">No send confirmation in this reply</p>
    <p className="leading-5 text-gray-600 dark:text-gray-300">Resolve the missing details above first. A message preview is not a send proposal. The confirmation button appears on the exact email review card.</p>
    {!open ? <button type="button" disabled={busy} onClick={load} className="rounded-md border border-primary/30 px-3 py-2 font-semibold text-primary disabled:opacity-50">Complete email details</button> : <form onSubmit={prepare} className="space-y-3">
      {status === "loading" && <p role="status">Loading sender choices from the current ERPBridge connection…</p>}
      {options?.choices.length > 0 && <label className="block font-medium">Sender address<select aria-label="Choose sender address" value={custom ? "$custom" : sender} disabled={locked} onChange={event => { setCustom(event.target.value === "$custom"); setSender(event.target.value === "$custom" ? "" : event.target.value); }} className="mt-1 w-full rounded-md border border-gray-300 bg-transparent p-2 dark:border-gray-600"><option value="">Choose a sender</option>{options.choices.map(value => <option key={value} value={value}>{value}</option>)}{!options.restricted && <option value="$custom">Use another sender address</option>}</select></label>}
      {(!options?.choices.length || custom) && <label className="block font-medium">Full sender email<input type="email" required maxLength={254} value={sender} disabled={locked} onChange={event => setSender(event.target.value)} placeholder="name@your-verified-domain.com" className="mt-1 w-full rounded-md border border-gray-300 bg-transparent p-2 dark:border-gray-600" /></label>}
      <p className="text-gray-500">{options?.choices.length ? options.restricted ? "Choices come from the current ERPBridge contract." : "Suggestions come from the current ERPBridge contract. Select the sender you want; the backend still checks the sending domain." : "Enter a full address, not just a domain."}</p>
      <label className="block font-medium">Recipient email (optional clarification)<input type="email" maxLength={254} value={recipient} disabled={locked} onChange={event => setRecipient(event.target.value)} placeholder="Keep the recipient from my request" className="mt-1 w-full rounded-md border border-gray-300 bg-transparent p-2 dark:border-gray-600" /></label>
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={locked || !sender} className="rounded-md bg-primary px-3 py-2 font-semibold text-white disabled:opacity-50">{status === "preparing" ? "Preparing…" : "Continue preparing email"}</button><button type="button" disabled={status === "preparing"} onClick={() => setOpen(false)} className="rounded-md border px-3 py-2">Close details</button></div>
    </form>}
    {notice && <p role="status" className="leading-5 text-gray-600 dark:text-gray-300">{notice}</p>}
  </section>;
}
