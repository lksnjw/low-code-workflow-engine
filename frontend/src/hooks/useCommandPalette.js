import { useState } from "react";

/*******************************************************************************
 * Function: useCommandPalette
 *
 * Provides command palette for the useCommandPalette module.
 ******************************************************************************/
export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  return { isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false) };
}

export default useCommandPalette;
