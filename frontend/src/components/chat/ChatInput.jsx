import { Icon } from "@iconify/react";
import Button from "../shared/ui/Button";

/*******************************************************************************
 * Function: ChatInput
 *
 * Performs the Chat Input operation on input for the ChatInput module.
 ******************************************************************************/
function ChatInput({ value, onChange, onSend, disabled }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-darkBackground">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Describe a workflow: trigger, decisions, tools, healing behavior..."
        className="min-h-20 flex-1 resize-none bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
      />
      <Button className="self-end" onClick={onSend} disabled={disabled}>
        <Icon icon="mdi:send" className="h-5 w-5" />
        {disabled ? "Sending" : "Send"}
      </Button>
    </div>
  );
}

export default ChatInput;
