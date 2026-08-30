import { Icon } from "@iconify/react";
import { useNotifications } from "../../../context/NotificationContext";

/*******************************************************************************
 * Function: CopyButton
 *
 * Performs the Copy Button operation on button for the CopyButton module.
 ******************************************************************************/
function CopyButton({ value }) {
  const { notify } = useNotifications();

/*******************************************************************************
 * Function: handleCopy
 *
 * Handles copy for the CopyButton module.
 ******************************************************************************/
  const handleCopy = async () => {
    await navigator.clipboard?.writeText(value);
    notify("Copied to clipboard.");
  };

  return (
    <button type="button" onClick={handleCopy} className="icon-button" aria-label="Copy">
      <Icon icon="mdi:content-copy" className="h-4 w-4" />
    </button>
  );
}

export default CopyButton;
