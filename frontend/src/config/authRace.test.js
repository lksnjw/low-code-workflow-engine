/** @jest-environment jsdom */

import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import React from "react";
import { apiClient, isNetworkError } from "./axios";
import { AuthProvider, useAuthContext } from "../context/AuthContext";

// Stub at the adapter layer so the real interceptors under test still run.
function ok(config, data) {
  return Promise.resolve({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
}
function httpError(config, status, data = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.config = config;
  error.request = {};
  error.response = { data, status, statusText: String(status), headers: {}, config, request: {} };
  return Promise.reject(error);
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

    render(React.createElement(AuthProvider, null, React.createElement(AuthStateProbe)));
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
