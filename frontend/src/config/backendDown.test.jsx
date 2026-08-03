/** @jest-environment jsdom */

import { afterEach, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import axios from "axios";
import { apiClient, isServerUnavailable } from "./axios";

const originalClientAdapter = apiClient.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;

function networkError(config) {
  const error = new Error("Network Error");
  error.config = config;
  error.request = {};
  return Promise.reject(error);
}
function ok(config, data) {
  return Promise.resolve({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
}

afterEach(() => {
  apiClient.defaults.adapter = originalClientAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
  localStorage.clear();
  cleanup();
});

const { AuthProvider, useAuthContext } = await import("../context/AuthContext");
const { default: ServerUnreachableBanner } = await import("../components/shared/ServerUnreachableBanner");

function Probe() {
  const { isAuthenticated, serverUnreachable } = useAuthContext();
  return (
    <div>
      <span data-testid="authed">{String(isAuthenticated)}</span>
      <span data-testid="unreachable">{String(serverUnreachable)}</span>
      <ServerUnreachableBanner />
    </div>
  );
}

test("a connection error keeps the session and shows the unreachable banner, not the login screen", async () => {
  localStorage.setItem("workflow.authToken", "tok");
  localStorage.setItem("workflow.refreshToken", "ref");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "usr_1", name: "Admin" }));

  apiClient.defaults.adapter = networkError;
  axios.defaults.adapter = networkError;

  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

  await waitFor(() => expect(screen.getByTestId("unreachable").textContent).toBe("true"));

  // Tokens intact — a transport failure is not an expiry.
  expect(localStorage.getItem("workflow.authToken")).toBe("tok");
  expect(localStorage.getItem("workflow.refreshToken")).toBe("ref");
  expect(localStorage.getItem("workflow.user")).not.toBeNull();
  // Still signed in, still on the app, with a banner and a Retry action.
  expect(screen.getByTestId("authed").textContent).toBe("true");
  const banner = screen.getByTestId("server-unreachable-banner");
  expect(banner.textContent).toMatch(/server is unreachable/i);
  expect(banner.textContent).toMatch(/Retry/);
  expect(screen.queryByText(/Welcome back/i)).toBeNull();
});

test("Retry restores the screen once the backend is back, with no re-authentication", async () => {
  localStorage.setItem("workflow.authToken", "tok");
  localStorage.setItem("workflow.refreshToken", "ref");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "usr_1", name: "Admin" }));

  apiClient.defaults.adapter = networkError;
  axios.defaults.adapter = networkError;

  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("unreachable").textContent).toBe("true"));

  // Backend comes back.
  apiClient.defaults.adapter = (config) => ok(config, { data: { id: "usr_1", name: "Admin" } });
  fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

  await waitFor(() => expect(screen.getByTestId("unreachable").textContent).toBe("false"));
  expect(screen.getByTestId("authed").textContent).toBe("true");
  expect(screen.queryByTestId("server-unreachable-banner")).toBeNull();
  expect(localStorage.getItem("workflow.authToken")).toBe("tok");
});

function proxyFiveHundred(config) {
  const error = new Error("Request failed with status code 500");
  error.config = config;
  error.request = {};
  error.response = { data: "", status: 500, statusText: "500", headers: {}, config, request: {} };
  return Promise.reject(error);
}

// A dev proxy answers 500 (and nginx 502/504) when the API is down. That is a
// health problem, not an expiry, and must not clear the session.
test("a 5xx from the proxy keeps the session and shows the banner", async () => {
  localStorage.setItem("workflow.authToken", "tok");
  localStorage.setItem("workflow.refreshToken", "ref");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "usr_1", name: "Admin" }));

  apiClient.defaults.adapter = proxyFiveHundred;
  axios.defaults.adapter = proxyFiveHundred;

  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

  await waitFor(() => expect(screen.getByTestId("unreachable").textContent).toBe("true"));
  expect(localStorage.getItem("workflow.authToken")).toBe("tok");
  expect(screen.getByTestId("authed").textContent).toBe("true");
  expect(screen.queryByText(/Welcome back/i)).toBeNull();
});

test("isServerUnavailable covers both no-response and 5xx, but not 401", () => {
  expect(isServerUnavailable({ request: {}, message: "Network Error" })).toBe(true);
  expect(isServerUnavailable({ response: { status: 500 } })).toBe(true);
  expect(isServerUnavailable({ response: { status: 502 } })).toBe(true);
  expect(isServerUnavailable({ response: { status: 401 } })).toBe(false);
  expect(isServerUnavailable({ response: { status: 403 } })).toBe(false);
});
