import axios from "axios";
import { appConfig } from "./app";
import { currentAuthorityEpoch } from "../utils/authAuthority";

export const apiClient = axios.create({
  baseURL: appConfig.apiBaseUrl,
  timeout: appConfig.apiRequestTimeoutMs,
  headers: {
    "Content-Type": "application/json",
  },
});

export const AUTH_STORAGE = {
  token: "workflow.authToken",
  refresh: "workflow.refreshToken",
  user: "workflow.user",
};

/*******************************************************************************
 * Function: clearStoredSession
 *
 * Clears stored session for the axios module.
 ******************************************************************************/
export function clearStoredSession() {
  localStorage.removeItem(AUTH_STORAGE.token);
  localStorage.removeItem(AUTH_STORAGE.refresh);
  localStorage.removeItem(AUTH_STORAGE.user);
  delete apiClient.defaults.headers.common.Authorization;
}

/**
 * A transport failure — no HTTP response at all (server down, DNS, timeout,
 * connection refused). This is never an authentication failure and must never
 * clear the session.
 */
/*******************************************************************************
 * Function: isNetworkError
 *
 * Determines whether network error for the axios module.
 ******************************************************************************/
export function isNetworkError(error) {
  if (!error) return false;
  // Navigation and monitor teardown intentionally abort outstanding polls.
  // Axios cancellation carries a request but says nothing about reachability.
  // Keep real ECONNABORTED timeouts in the transport-failure branch below.
  if (axios.isCancel(error) || error.code === "ERR_CANCELED" || error.name === "AbortError") return false;
  if (error.response) return false;
  return Boolean(error.request) || error.code === "ECONNABORTED" || error.message === "Network Error";
}

/** The API is unreachable only when no HTTP response was received. */
/*******************************************************************************
 * Function: isServerUnavailable
 *
 * Determines whether server unavailable for the axios module.
 ******************************************************************************/
export function isServerUnavailable(error) {
  return isNetworkError(error);
}

// Attach Bearer token to every request
apiClient.interceptors.request.use((config) => {
  if (config._authEpoch === undefined) config._authEpoch = currentAuthorityEpoch();
  if (config._authEpoch !== currentAuthorityEpoch()) {
    const error = new Error("Authentication changed before the request was dispatched");
    error.code = "ERR_STALE_AUTHORITY";
    return Promise.reject(error);
  }
  const token = config._authTokenOverride ? "" : localStorage.getItem(AUTH_STORAGE.token);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  } else if (!config._authTokenOverride) {
    delete config.headers.Authorization;
    delete config.headers.authorization;
  }
  delete config._authTokenOverride;
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

/*******************************************************************************
 * Function: getRefreshInFlight
 *
 * Gets refresh in flight for the axios module.
 ******************************************************************************/
export function getRefreshInFlight() {
  return refreshPromise?.promise ?? null;
}

export function getRefreshEpoch() {
  return refreshPromise?.epoch ?? null;
}

/*******************************************************************************
 * Function: refreshSession
 *
 * Refreshes session for the axios module.
 ******************************************************************************/
export function refreshSession(expectedEpoch = currentAuthorityEpoch()) {
  if (expectedEpoch !== currentAuthorityEpoch()) return Promise.reject(new Error("Authentication changed before refresh"));
  if (refreshPromise?.epoch === expectedEpoch) return refreshPromise.promise;

  const refreshToken = localStorage.getItem(AUTH_STORAGE.refresh);
  if (!refreshToken) return Promise.reject(new Error("no refresh token stored"));

  // Bare axios, not apiClient: the request interceptor would otherwise attach
  // the expired access token, and a failure here must not re-enter this logic.
  const pending = { epoch: expectedEpoch, promise: null };
  pending.promise = axios
    .post(`${appConfig.apiBaseUrl}/auth/refresh`, { refreshToken }, { timeout: appConfig.apiRequestTimeoutMs })
    .then((response) => {
      if (expectedEpoch !== currentAuthorityEpoch()) throw new Error("Authentication changed during refresh");
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
      if (refreshPromise === pending) refreshPromise = null;
    });
  refreshPromise = pending;

  // Keep the public getter's historical promise shape while allowing auth
  // bootstrap to join only a refresh owned by its own authority epoch.
  Object.defineProperty(pending.promise, "epoch", { value: expectedEpoch, configurable: true });

  return pending.promise;
}

// Endpoints that must never trigger a refresh, because refreshing them is
// either meaningless or recursive. /auth/me is deliberately NOT in this list:
// it is an ordinary authenticated request and must be refreshed and retried
// like any other.
const NON_REFRESHABLE = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"];

apiClient.interceptors.response.use(
  (response) => {
    const requestEpoch = response.config?._authEpoch;
    if (requestEpoch !== undefined && requestEpoch !== currentAuthorityEpoch()) {
      const error = new Error("Authentication changed before the response was accepted");
      error.code = "ERR_STALE_AUTHORITY";
      error.config = response.config;
      return Promise.reject(error);
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config || {};
    const requestEpoch = originalRequest._authEpoch;
    if (requestEpoch !== undefined && requestEpoch !== currentAuthorityEpoch()) return Promise.reject(error);

    // No HTTP response was received. Keep the session and tell the app.
    if (isServerUnavailable(error)) {
      window.dispatchEvent(new CustomEvent("auth:unreachable"));
      return Promise.reject(error);
    }

    const url = originalRequest.url || "";
/*******************************************************************************
 * Function: canRefresh
 *
 * Determines whether refresh for the axios module.
 ******************************************************************************/
    const canRefresh =
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !NON_REFRESHABLE.some((prefix) => url.startsWith(prefix)) &&
      localStorage.getItem(AUTH_STORAGE.refresh);

    if (!canRefresh) return Promise.reject(error);

    originalRequest._retry = true;
    try {
      const token = await refreshSession(requestEpoch ?? currentAuthorityEpoch());
      if ((requestEpoch ?? currentAuthorityEpoch()) !== currentAuthorityEpoch()) return Promise.reject(error);
      originalRequest.headers = originalRequest.headers || {};
      originalRequest.headers.Authorization = `Bearer ${token}`;
      return apiClient(originalRequest);
    } catch (refreshError) {
      if ((requestEpoch ?? currentAuthorityEpoch()) !== currentAuthorityEpoch()) return Promise.reject(refreshError);
      // The refresh itself failed. That, and only that, ends the session.
      if (isServerUnavailable(refreshError) || ![401, 403].includes(refreshError?.response?.status)) {
        window.dispatchEvent(new CustomEvent("auth:unreachable"));
        return Promise.reject(refreshError);
      }
      clearStoredSession();
      window.dispatchEvent(new CustomEvent("auth:expired"));
      return Promise.reject(refreshError);
    }
  },
);
