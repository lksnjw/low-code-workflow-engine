import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AUTH_STORAGE, getRefreshInFlight, isServerUnavailable } from "../config/axios";
import { authService } from "../services/auth.service";

const AuthContext = createContext(null);

/*******************************************************************************
 * Function: loadStoredUser
 *
 * Loads stored user for the AuthContext module.
 ******************************************************************************/
function loadStoredUser() {
  try {
    const raw = localStorage.getItem("workflow.user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/*******************************************************************************
 * Function: loadCurrentUser
 *
 * Loads current user for the AuthContext module.
 ******************************************************************************/
async function loadCurrentUser() {
  const refreshInFlight = getRefreshInFlight();
  if (refreshInFlight) {
    await refreshInFlight;
  }
  return authService.me();
}

/*******************************************************************************
 * Function: AuthProvider
 *
 * Performs the Auth Provider operation on provider for the AuthContext module.
 ******************************************************************************/
export function AuthProvider({ children }) {
  const [user, setUser] = useState(loadStoredUser);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [serverUnreachable, setServerUnreachable] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // On mount, validate the stored token via /auth/me.
  //
  // /auth/me now goes through the same serialised refresh queue as every other
  // request, so a 401 here has already been refreshed and retried once by the
  // interceptor. Reaching the catch means either the refresh itself failed
  // (a real expiry) or the server is unreachable (not an auth problem at all).
  useEffect(() => {
    const token = localStorage.getItem(AUTH_STORAGE.token);
    if (!token) return undefined;
    let cancelled = false;
    loadCurrentUser()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setServerUnreachable(false);
        localStorage.setItem(AUTH_STORAGE.user, JSON.stringify(me));
      })
      .catch((error) => {
        if (cancelled) return;
        if (isServerUnavailable(error)) {
          // Keep the session and the screen. The server is simply down.
          setServerUnreachable(true);
          return;
        }
        // A /auth/me failure never ends the session. Its 401 has already gone
        // through the shared refresh queue; only refreshSession itself may
        // clear storage and dispatch auth:expired.
      });
    return () => {
      cancelled = true;
    };
  }, [reconnectNonce]);

  // Listen for session events from the axios interceptor
  useEffect(() => {
/*******************************************************************************
 * Function: handleExpired
 *
 * Handles expired for the AuthContext module.
 ******************************************************************************/
    const handleExpired = () => setUser(null);
/*******************************************************************************
 * Function: handleUnreachable
 *
 * Handles unreachable for the AuthContext module.
 ******************************************************************************/
    const handleUnreachable = () => setServerUnreachable(true);
    window.addEventListener("auth:expired", handleExpired);
    window.addEventListener("auth:unreachable", handleUnreachable);
    return () => {
      window.removeEventListener("auth:expired", handleExpired);
      window.removeEventListener("auth:unreachable", handleUnreachable);
    };
  }, []);

  // Re-runs the /auth/me probe. On success the banner clears and the user is
  // back where they were, with no re-authentication.
/*******************************************************************************
 * Function: retryConnection
 *
 * Performs the retry Connection operation on connection for the AuthContext module.
 ******************************************************************************/
  const retryConnection = useCallback(() => {
    setReconnectNonce((value) => value + 1);
  }, []);

/*******************************************************************************
 * Function: login
 *
 * Performs the login operation on the application for the AuthContext module.
 ******************************************************************************/
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

/*******************************************************************************
 * Function: register
 *
 * Performs the register operation on the application for the AuthContext module.
 ******************************************************************************/
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

/*******************************************************************************
 * Function: logout
 *
 * Performs the logout operation on the application for the AuthContext module.
 ******************************************************************************/
  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
    setAuthError("");
  }, []);

/*******************************************************************************
 * Function: refreshUser
 *
 * Refreshes user for the AuthContext module.
 ******************************************************************************/
  const refreshUser = useCallback(async () => {
    const me = await authService.me();
    setUser(me);
    localStorage.setItem("workflow.user", JSON.stringify(me));
    return me;
  }, []);

/*******************************************************************************
 * Function: clearError
 *
 * Clears error for the AuthContext module.
 ******************************************************************************/
  const clearError = useCallback(() => setAuthError(""), []);

/*******************************************************************************
 * Function: value
 *
 * Performs the value operation on the application for the AuthContext module.
 ******************************************************************************/
  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      loading,
      authError,
      serverUnreachable,
      retryConnection,
      login,
      register,
      logout,
      refreshUser,
      clearError,
    }),
    [user, loading, authError, serverUnreachable, retryConnection, login, register, logout, refreshUser, clearError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/*******************************************************************************
 * Function: useAuthContext
 *
 * Provides auth context for the AuthContext module.
 ******************************************************************************/
export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuthContext must be used within AuthProvider");
  }
  return context;
}
