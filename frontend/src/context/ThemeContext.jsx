import { createContext, useContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext(null);

/*******************************************************************************
 * Function: ThemeProvider
 *
 * Performs the Theme Provider operation on provider for the ThemeContext module.
 ******************************************************************************/
export function ThemeProvider({ children }) {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem("theme");
    return savedTheme !== "light";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
    localStorage.setItem("theme", isDarkMode ? "dark" : "light");
  }, [isDarkMode]);

/*******************************************************************************
 * Function: value
 *
 * Performs the value operation on the application for the ThemeContext module.
 ******************************************************************************/
  const value = useMemo(
    () => ({
      isDarkMode,
      themeName: isDarkMode ? "dark" : "light",
      toggleTheme: () => setIsDarkMode((current) => !current),
    }),
    [isDarkMode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/*******************************************************************************
 * Function: useTheme
 *
 * Provides theme for the ThemeContext module.
 ******************************************************************************/
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
