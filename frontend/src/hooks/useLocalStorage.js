import { useEffect, useState } from "react";

/*******************************************************************************
 * Function: useLocalStorage
 *
 * Provides local storage for the useLocalStorage module.
 ******************************************************************************/
export function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : initialValue;
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

export default useLocalStorage;
