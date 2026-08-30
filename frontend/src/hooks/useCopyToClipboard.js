import { useState } from "react";

/*******************************************************************************
 * Function: useCopyToClipboard
 *
 * Provides copy to clipboard for the useCopyToClipboard module.
 ******************************************************************************/
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);

/*******************************************************************************
 * Function: copy
 *
 * Performs the copy operation on the application for the useCopyToClipboard module.
 ******************************************************************************/
  const copy = async (value) => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return { copied, copy };
}

export default useCopyToClipboard;
