import { useEffect } from "react";

/*******************************************************************************
 * Function: useKeyboardShortcut
 *
 * Provides keyboard shortcut for the useKeyboardShortcut module.
 ******************************************************************************/
export function useKeyboardShortcut(key, callback) {
  useEffect(() => {
/*******************************************************************************
 * Function: handler
 *
 * Performs the handler operation on the application for the useKeyboardShortcut module.
 ******************************************************************************/
    const handler = (event) => {
      if (event.key.toLowerCase() === key.toLowerCase()) {
        callback?.(event);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [callback, key]);
}

export default useKeyboardShortcut;
