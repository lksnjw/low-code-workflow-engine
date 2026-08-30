import { useEffect, useState } from "react";

/*******************************************************************************
 * Function: useDebounce
 *
 * Provides debounce for the useDebounce module.
 ******************************************************************************/
export function useDebounce(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
/*******************************************************************************
 * Function: timer
 *
 * Performs the timer operation on the application for the useDebounce module.
 ******************************************************************************/
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debounced;
}

export default useDebounce;
