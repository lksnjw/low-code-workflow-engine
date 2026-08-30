import { useEffect } from "react";

/*******************************************************************************
 * Function: useClickOutside
 *
 * Provides click outside for the useClickOutside module.
 ******************************************************************************/
export function useClickOutside(ref, onClickOutside) {
  useEffect(() => {
/*******************************************************************************
 * Function: handler
 *
 * Performs the handler operation on the application for the useClickOutside module.
 ******************************************************************************/
    const handler = (event) => {
      if (ref.current && !ref.current.contains(event.target)) {
        onClickOutside?.(event);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClickOutside, ref]);
}

export default useClickOutside;
