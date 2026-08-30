import { useState } from "react";
import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";
import { settingsService } from "../../services/settings.service";
import { apiErrorMessage } from "../../services/api";
import { useNotifications } from "../../context/NotificationContext";

/*******************************************************************************
 * Function: WebhookForm
 *
 * Performs the Webhook Form operation on form for the WebhookForm module.
 ******************************************************************************/
function WebhookForm({ onCreated }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const { notify } = useNotifications();
/*******************************************************************************
 * Function: submit
 *
 * Performs the submit operation on the application for the WebhookForm module.
 ******************************************************************************/
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await settingsService.createWebhook({ name, url, events: ["execution.completed", "execution.failed"] });
      setName(""); setUrl(""); notify("Webhook created.", "success"); await onCreated?.();
    } catch (error) {
      notify(apiErrorMessage(error, "Could not create webhook."), "error");
    } finally { setSaving(false); }
  };
  return <form className="grid gap-2 sm:grid-cols-[0.7fr_1.3fr_auto]" onSubmit={submit}><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Webhook name" required /><Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://service.example/webhooks" required /><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Add"}</Button></form>;
}

export default WebhookForm;
