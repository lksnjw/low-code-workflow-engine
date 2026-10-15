/** @jest-environment jsdom */

import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axios from "axios";
import React from "react";
import { apiClient, clearStoredSession, getRefreshInFlight, isNetworkError, refreshSession } from "./axios";
import { AuthProvider, useAuthContext } from "../context/AuthContext";
import { captureAuthority, currentAuthorityEpoch, isAuthorityCurrent, transitionAuthority } from "../utils/authAuthority";
import { authService } from "../services/auth.service";

// Stub at the adapter layer so the real interceptors under test still run.
function ok(config, data) {
  return Promise.resolve({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
}
function httpError(config, status, data = {}) {
  return Promise.reject(httpErrorValue(config, status, data));
}
function httpErrorValue(config, status, data = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.config = config;
  error.request = {};
  error.response = { data, status, statusText: String(status), headers: {}, config, request: {} };
  return error;
}
function networkError(config) {
  const error = new Error("Network Error");
  error.config = config;
  error.request = {};
  return Promise.reject(error);
}
const authHeader = (config) => config.headers?.Authorization ?? config.headers?.get?.("Authorization");

function seedSession() {
  localStorage.setItem("workflow.authToken", "expired-access");
  localStorage.setItem("workflow.refreshToken", "good-refresh-0");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "usr_1" }));
}

test.each([429, 500, 503, 504])("a temporary refresh response %s preserves the existing session and does not replay business work", async status => {
  seedSession();
  const expired = jest.fn(); window.addEventListener("auth:expired", expired);
  axios.defaults.adapter = config => httpError(config, status);
  const requests = [];
  apiClient.defaults.adapter = config => { requests.push(config.url); return httpError(config, 401); };
  try {
    await expect(apiClient.get("/auth/me")).rejects.toMatchObject({ response: { status } });
    expect(localStorage.getItem("workflow.refreshToken")).toBe("good-refresh-0");
    expect(localStorage.getItem("workflow.user")).not.toBeNull();
    expect(expired).not.toHaveBeenCalled(); expect(requests).toEqual(["/auth/me"]);
  } finally { window.removeEventListener("auth:expired", expired); }
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const originalClientAdapter = apiClient.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  apiClient.defaults.adapter = originalClientAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
  delete apiClient.defaults.headers.common.Authorization;
  cleanup();
});

function AuthStateProbe() {
  const { isAuthenticated } = useAuthContext();
  return React.createElement("span", { "data-testid": "authed" }, String(isAuthenticated));
}

// The exact production failure: /auth/me and another request 401 concurrently
// while a single refresh succeeds. The session must survive and both must be
// retried. Looped 20 times, because the original defect was a race.
test("concurrent 401s on /auth/me and another request survive a successful refresh", async () => {
  for (let i = 0; i < 20; i += 1) {
    localStorage.clear();
    seedSession();
    delete apiClient.defaults.headers.common.Authorization;

    let refreshCalls = 0;
    let initial401s = 0;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const fresh = `fresh-${i}`;
    axios.defaults.adapter = async (config) => {
      if (String(config.url).includes("/auth/refresh")) {
        refreshCalls += 1;
        await refreshGate;
        return ok(config, { data: { accessToken: fresh, refreshToken: `good-refresh-${i + 1}` } });
      }
      return networkError(config);
    };
    const retried = new Set();
    apiClient.defaults.adapter = (config) => {
      if (authHeader(config) === `Bearer ${fresh}`) {
        retried.add(config.url);
        const data = config.url === "/auth/me" ? { data: { id: "usr_1" } } : { data: [] };
        return ok(config, data);
      }
      initial401s += 1;
      if (initial401s === 2) releaseRefresh();
      return httpError(config, 401);
    };

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(AuthProvider, null, React.createElement(AuthStateProbe))));
    const notifications = await apiClient.get("/notifications");
    await waitFor(() => expect(retried).toEqual(new Set(["/auth/me", "/notifications"])));

    expect(notifications.status).toBe(200);
    expect(initial401s).toBe(2);
    expect(refreshCalls).toBe(1); // one shared refresh, not one per request
    expect(screen.getByTestId("authed").textContent).toBe("true");
    expect(localStorage.getItem("workflow.authToken")).toBe(fresh);
    // The rotated refresh token must be persisted or the next rotation fails.
    expect(localStorage.getItem("workflow.refreshToken")).toBe(`good-refresh-${i + 1}`);
    expect(localStorage.getItem("workflow.user")).not.toBeNull();
    cleanup();
    queryClient.clear();
  }
});

test("three consecutive rotations keep the session", async () => {
  seedSession();
  let issued = 0;
  axios.defaults.adapter = (config) => {
    const sent = JSON.parse(config.data).refreshToken;
    // The server invalidates the old digest; replaying a stale one must fail.
    if (sent !== `good-refresh-${issued}`) return httpError(config, 401);
    issued += 1;
    return ok(config, { data: { accessToken: `access-${issued}`, refreshToken: `good-refresh-${issued}` } });
  };

  for (let rotation = 1; rotation <= 3; rotation += 1) {
    apiClient.defaults.adapter = (config) =>
      authHeader(config) === `Bearer access-${rotation}` ? ok(config, { data: [] }) : httpError(config, 401);
    const response = await apiClient.get("/workflows");
    expect(response.status).toBe(200);
  }
  expect(issued).toBe(3);
  expect(localStorage.getItem("workflow.authToken")).toBe("access-3");
});

test("the session is cleared only when the refresh itself fails", async () => {
  seedSession();
  axios.defaults.adapter = (config) => httpError(config, 401);
  apiClient.defaults.adapter = (config) => httpError(config, 401);

  const expired = jest.fn();
  window.addEventListener("auth:expired", expired);
  await expect(apiClient.get("/auth/me")).rejects.toBeDefined();

  expect(localStorage.getItem("workflow.authToken")).toBeNull();
  expect(localStorage.getItem("workflow.refreshToken")).toBeNull();
  expect(expired).toHaveBeenCalled();
  window.removeEventListener("auth:expired", expired);
});

test("a 401 on an ordinary request never logs out while the refresh succeeds", async () => {
  seedSession();
  axios.defaults.adapter = (config) => ok(config, { data: { accessToken: "fresh", refreshToken: "next" } });
  apiClient.defaults.adapter = (config) =>
    authHeader(config) === "Bearer fresh" ? ok(config, { data: [] }) : httpError(config, 401);

  const expired = jest.fn();
  window.addEventListener("auth:expired", expired);
  const response = await apiClient.get("/executions");
  expect(response.status).toBe(200);
  expect(expired).not.toHaveBeenCalled();
  expect(localStorage.getItem("workflow.authToken")).toBe("fresh");
  window.removeEventListener("auth:expired", expired);
});

test("isNetworkError distinguishes a transport failure from an HTTP status", () => {
  expect(isNetworkError({ request: {}, message: "Network Error" })).toBe(true);
  expect(isNetworkError({ code: "ECONNABORTED", message: "timeout" })).toBe(true);
  expect(isNetworkError({ response: { status: 401 } })).toBe(false);
});

test("an old A 401 is rejected before refresh or replay with B credentials", async () => {
  transitionAuthority({ id: "actor-a", role: "Operator", permissions: ["chat:use"] });
  localStorage.setItem("workflow.authToken", "token-a");
  localStorage.setItem("workflow.refreshToken", "refresh-a");
  let sentConfig;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = deferred();
  let calls = 0, refreshCalls = 0;
  apiClient.defaults.adapter = config => { calls += 1; sentConfig = config; markStarted(); return gate.promise; };
  axios.defaults.adapter = config => { refreshCalls += 1; return httpError(config, 401); };
  const pending = apiClient.get("/private-chat");
  await started;
  transitionAuthority({ id: "actor-b", role: "Operator", permissions: ["chat:use"] });
  localStorage.setItem("workflow.authToken", "token-b");
  localStorage.setItem("workflow.refreshToken", "refresh-b");
  gate.reject(httpErrorValue(sentConfig, 401));
  await expect(pending).rejects.toMatchObject({ response: { status: 401 } });
  expect(authHeader(sentConfig)).toBe("Bearer token-a");
  expect(calls).toBe(1);
  expect(refreshCalls).toBe(0);
  expect(localStorage.getItem("workflow.authToken")).toBe("token-b");
});

test("a held A refresh success or failure cannot change B credentials or emit B expiry", async () => {
  for (const failRefresh of [false, true]) {
    localStorage.clear();
    transitionAuthority({ id: "actor-a", role: "Operator", permissions: ["chat:use"] });
    localStorage.setItem("workflow.authToken", "token-a");
    localStorage.setItem("workflow.refreshToken", "refresh-a");
    let markRefresh;
    const refreshStarted = new Promise(resolve => { markRefresh = resolve; });
    const refreshGate = deferred();
    apiClient.defaults.adapter = config => httpError(config, 401);
    axios.defaults.adapter = config => { markRefresh(config); return refreshGate.promise; };
    const expired = jest.fn();
    window.addEventListener("auth:expired", expired);
    const pending = apiClient.get("/private-chat");
    const refreshConfig = await refreshStarted;
    transitionAuthority({ id: "actor-b", role: "Operator", permissions: ["chat:use"] });
    localStorage.setItem("workflow.authToken", "token-b");
    localStorage.setItem("workflow.refreshToken", "refresh-b");
    if (failRefresh) refreshGate.reject(httpErrorValue(refreshConfig, 401));
    else refreshGate.resolve({ data: { data: { accessToken: "late-a", refreshToken: "late-refresh-a" } }, status: 200, statusText: "OK", headers: {}, config: refreshConfig, request: {} });
    await expect(pending).rejects.toBeDefined();
    expect(localStorage.getItem("workflow.authToken")).toBe("token-b");
    expect(localStorage.getItem("workflow.refreshToken")).toBe("refresh-b");
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener("auth:expired", expired);
  }
});

test("a late successful A login cannot persist credentials after B replaces it", async () => {
  transitionAuthority({ id: "actor-a", role: "Operator", permissions: ["chat:use"] });
  let sentConfig;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = deferred();
  apiClient.defaults.adapter = config => { sentConfig = config; markStarted(); return gate.promise; };
  const pending = authService.login({ email: "a@example.test" });
  await started;
  transitionAuthority({ id: "actor-b", role: "Operator", permissions: ["chat:use"] });
  localStorage.setItem("workflow.authToken", "token-b");
  localStorage.setItem("workflow.refreshToken", "refresh-b");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "actor-b" }));
  gate.resolve({ data: { data: { accessToken: "late-a", refreshToken: "late-refresh-a", user: { id: "actor-a" } } }, status: 200, statusText: "OK", headers: {}, config: sentConfig, request: {} });
  await expect(pending).rejects.toMatchObject({ code: "ERR_STALE_AUTHORITY" });
  expect(localStorage.getItem("workflow.authToken")).toBe("token-b");
  expect(localStorage.getItem("workflow.refreshToken")).toBe("refresh-b");
  expect(JSON.parse(localStorage.getItem("workflow.user"))).toEqual({ id: "actor-b" });
});

test("a delayed logout revocation cannot clear B and uses only A's captured credential", async () => {
  const epochA = transitionAuthority({ id: "actor-a", role: "Operator", permissions: ["chat:use"] }).epoch;
  localStorage.setItem("workflow.authToken", "token-a");
  localStorage.setItem("workflow.refreshToken", "refresh-a");
  const captureA = captureAuthority({ id: "actor-a", role: "Operator", permissions: ["chat:use"] });
  let sentConfig;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = deferred();
  apiClient.defaults.adapter = config => { sentConfig = config; markStarted(); return gate.promise; };
  clearStoredSession();
  const pending = authService.logout({ isCurrent: () => isAuthorityCurrent(captureA), accessToken: "token-a", refreshToken: "refresh-a" });
  await started;
  transitionAuthority({ id: "actor-b", role: "Operator", permissions: ["chat:use"] });
  localStorage.setItem("workflow.authToken", "token-b");
  localStorage.setItem("workflow.refreshToken", "refresh-b");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "actor-b" }));
  gate.resolve({ data: { data: { loggedOut: true } }, status: 200, statusText: "OK", headers: {}, config: sentConfig, request: {} });
  await pending;
  expect(authHeader(sentConfig)).toBe("Bearer token-a");
  expect(JSON.parse(sentConfig.data).refreshToken).toBe("refresh-a");
  expect(localStorage.getItem("workflow.authToken")).toBe("token-b");
  expect(localStorage.getItem("workflow.refreshToken")).toBe("refresh-b");
  expect(JSON.parse(localStorage.getItem("workflow.user"))).toEqual({ id: "actor-b" });
  expect(currentAuthorityEpoch()).toBeGreaterThan(epochA);
});

test("an older refresh finally cannot clear a newer account's shared refresh promise", async () => {
  const userA = { id: "actor-a", role: "Operator", permissions: ["chat:use"] };
  const userB = { id: "actor-b", role: "Operator", permissions: ["chat:use"] };
  const epochA = transitionAuthority(userA).epoch;
  localStorage.setItem("workflow.refreshToken", "refresh-a");
  const gates = new Map();
  const configs = [];
  axios.defaults.adapter = config => {
    const refreshToken = JSON.parse(config.data).refreshToken;
    const gate = deferred();
    gates.set(refreshToken, gate);
    configs.push(config);
    return gate.promise;
  };
  const refreshA = refreshSession(epochA);
  await waitFor(() => expect(configs).toHaveLength(1));
  const epochB = transitionAuthority(userB).epoch;
  localStorage.setItem("workflow.refreshToken", "refresh-b");
  const refreshB = refreshSession(epochB);
  await waitFor(() => expect(configs).toHaveLength(2));
  gates.get("refresh-a").reject(httpErrorValue(configs[0], 401));
  await expect(refreshA).rejects.toBeDefined();
  expect(getRefreshInFlight()).toBe(refreshB);
  gates.get("refresh-b").resolve({ data: { data: { accessToken: "token-b2", refreshToken: "refresh-b2" } }, status: 200, statusText: "OK", headers: {}, config: configs[1], request: {} });
  await expect(refreshB).resolves.toBe("token-b2");
  expect(localStorage.getItem("workflow.authToken")).toBe("token-b2");
  expect(localStorage.getItem("workflow.refreshToken")).toBe("refresh-b2");
  expect(currentAuthorityEpoch()).toBe(epochB);
});
