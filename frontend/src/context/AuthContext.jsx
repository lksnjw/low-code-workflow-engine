import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { authService } from "../services/auth.service";

const AuthContext = createContext(null);

function loadStoredUser() {
  try {
    const raw = localStorage.getItem("workflow.user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(loadStoredUser);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState("");

  // On mount, validate the stored token via /auth/me
  useEffect(() => {
    const token = localStorage.getItem("workflow.authToken");
    if (!token) return;
    let cancelled = false;
    authService
      .me()
      .then((me) => {
        if (!cancelled) {
          setUser(me);
          localStorage.setItem("workflow.user", JSON.stringify(me));
        }
      })
      .catch(() => {
        if (!cancelled) {
          localStorage.removeItem("workflow.authToken");
          localStorage.removeItem("workflow.user");
          setUser(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for token expiry events from the axios interceptor
  useEffect(() => {
    const handleExpired = () => {
      setUser(null);
    };
    window.addEventListener("auth:expired", handleExpired);
    return () => window.removeEventListener("auth:expired", handleExpired);
  }, []);

  const login = useCallback(async (credentials) => {
    setLoading(true);
    setAuthError("");
    try {
      const session = await authService.login(credentials);
      setUser(session.user ?? session);
      return session;
    } catch (err) {
      const msg = err?.response?.data?.message ?? "Login failed. Please check your credentials.";
      setAuthError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(async (payload) => {
    setLoading(true);
    setAuthError("");
    try {
      const session = await authService.register(payload);
      setUser(session.user ?? session);
      return session;
    } catch (err) {
      const msg = err?.response?.data?.message ?? "Registration failed. Please try again.";
      setAuthError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
    setAuthError("");
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await authService.me();
    setUser(me);
    localStorage.setItem("workflow.user", JSON.stringify(me));
    return me;
  }, []);

  const clearError = useCallback(() => setAuthError(""), []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      loading,
      authError,
      login,
      register,
      logout,
      refreshUser,
      clearError,
    }),
    [user, loading, authError, login, register, logout, refreshUser, clearError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuthContext must be used within AuthProvider");
  }
  return context;
}
