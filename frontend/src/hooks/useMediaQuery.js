import { useEffect, useState } from "react";

/*******************************************************************************
 * Function: useMediaQuery
 *
 * Provides media query for the useMediaQuery module.
 ******************************************************************************/
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
/*******************************************************************************
 * Function: handler
 *
 * Performs the handler operation on the application for the useMediaQuery module.
 ******************************************************************************/
    const handler = () => setMatches(media.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export default useMediaQuery;
