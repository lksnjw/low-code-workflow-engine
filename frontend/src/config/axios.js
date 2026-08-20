import axios from "axios";
import { appConfig } from "./app";

export const apiClient = axios.create({
  baseURL: appConfig.apiBaseUrl,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

export const AUTH_STORAGE = {
  token: "workflow.authToken",
  refresh: "workflow.refreshToken",
  user: "workflow.user",
};

export function clearStoredSession() {
  localStorage.removeItem(AUTH_STORAGE.token);
  localStorage.removeItem(AUTH_STORAGE.refresh);
  localStorage.removeItem(AUTH_STORAGE.user);
}

/**
 * A transport failure — no HTTP response at all (server down, DNS, timeout,
 * connection refused). This is never an authentication failure and must never
 * clear the session.
 */
export function isNetworkError(error) {
  if (!error) return false;
  if (error.response) return false;
  return Boolean(error.request) || error.code === "ECONNABORTED" || error.message === "Network Error";
}

/** The API is unreachable only when no HTTP response was received. */
export function isServerUnavailable(error) {
  return isNetworkError(error);
}

// Attach Bearer token to every request
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem(AUTH_STORAGE.token);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ---------------------------------------------------------------------------
// One shared source of truth for "a refresh is in flight".
//
// Every caller — the response interceptor and AuthContext alike — awaits this
// same promise, so concurrent 401s produce exactly one refresh call and all of
// them are retried with the resulting token.
// ---------------------------------------------------------------------------
let refreshPromise = null;

export function getRefreshInFlight() {
  return refreshPromise;
}

export function refreshSession() {
  if (refreshPromise) return refreshPromise;

  const refreshToken = localStorage.getItem(AUTH_STORAGE.refresh);
  if (!refreshToken) return Promise.reject(new Error("no refresh token stored"));

  // Bare axios, not apiClient: the request interceptor would otherwise attach
  // the expired access token, and a failure here must not re-enter this logic.
  refreshPromise = axios
    .post(`${appConfig.apiBaseUrl}/auth/refresh`, { refreshToken })
    .then((response) => {
      const session = response.data?.data ?? {};
      if (!session.accessToken) throw new Error("refresh returned no access token");
      localStorage.setItem(AUTH_STORAGE.token, session.accessToken);
      // The server rotates the refresh token and invalidates the old digest.
      // Persisting the new one is what makes a SECOND rotation possible.
      if (session.refreshToken) localStorage.setItem(AUTH_STORAGE.refresh, session.refreshToken);
      apiClient.defaults.headers.common.Authorization = `Bearer ${session.accessToken}`;
      return session.accessToken;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

// Endpoints that must never trigger a refresh, because refreshing them is
// either meaningless or recursive. /auth/me is deliberately NOT in this list:
// it is an ordinary authenticated request and must be refreshed and retried
// like any other.
const NON_REFRESHABLE = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"];

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config || {};

    // No HTTP response was received. Keep the session and tell the app.
    if (isServerUnavailable(error)) {
      window.dispatchEvent(new CustomEvent("auth:unreachable"));
      return Promise.reject(error);
    }

    const url = originalRequest.url || "";
    const canRefresh =
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !NON_REFRESHABLE.some((prefix) => url.startsWith(prefix)) &&
      localStorage.getItem(AUTH_STORAGE.refresh);

    if (!canRefresh) return Promise.reject(error);

    originalRequest._retry = true;
    try {
      const token = await refreshSession();
      originalRequest.headers = originalRequest.headers || {};
      originalRequest.headers.Authorization = `Bearer ${token}`;
      return apiClient(originalRequest);
    } catch (refreshError) {
      // The refresh itself failed. That, and only that, ends the session.
      if (isServerUnavailable(refreshError)) {
        window.dispatchEvent(new CustomEvent("auth:unreachable"));
        return Promise.reject(refreshError);
      }
      clearStoredSession();
      window.dispatchEvent(new CustomEvent("auth:expired"));
      return Promise.reject(refreshError);
    }
  },
);
