/** @jest-environment jsdom */

import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import axios from "axios";
import { apiClient } from "./axios";

function response(config, data) {
  return Promise.resolve({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
}

function unauthorized(config) {
  const error = new Error("Request failed with status code 401");
  error.config = config;
  error.request = {};
  error.response = { data: {}, status: 401, statusText: "Unauthorized", headers: {}, config, request: {} };
  return Promise.reject(error);
}

function authorization(config) {
  return config.headers?.Authorization ?? config.headers?.get?.("Authorization");
}

const originalClientAdapter = apiClient.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;

beforeEach(() => {
  localStorage.clear();
  delete apiClient.defaults.headers.common.Authorization;
});

afterEach(() => {
  apiClient.defaults.adapter = originalClientAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
  delete apiClient.defaults.headers.common.Authorization;
  localStorage.clear();
});

test("two consecutive refresh rotations preserve the session", async () => {
  localStorage.setItem("workflow.authToken", "expired-access");
  localStorage.setItem("workflow.refreshToken", "refresh-0");
  localStorage.setItem("workflow.user", JSON.stringify({ id: "user-1" }));

  let rotation = 0;
  const submittedRefreshTokens = [];
  const adapter = (config) => {
    if (String(config.url).includes("/auth/refresh")) {
      const submitted = JSON.parse(config.data).refreshToken;
      submittedRefreshTokens.push(submitted);
      if (submitted !== `refresh-${rotation}`) return unauthorized(config);
      rotation += 1;
      return response(config, {
        data: { accessToken: `access-${rotation}`, refreshToken: `refresh-${rotation}` },
      });
    }

    if (config._retry && authorization(config) === `Bearer access-${rotation}`) {
      return response(config, { data: [] });
    }
    return unauthorized(config);
  };
  apiClient.defaults.adapter = adapter;
  axios.defaults.adapter = adapter;

  const expired = jest.fn();
  window.addEventListener("auth:expired", expired);
  try {
    await expect(apiClient.get("/workflows?cycle=1")).resolves.toHaveProperty("status", 200);
    await expect(apiClient.get("/workflows?cycle=2")).resolves.toHaveProperty("status", 200);
  } finally {
    window.removeEventListener("auth:expired", expired);
  }

  expect(submittedRefreshTokens).toEqual(["refresh-0", "refresh-1"]);
  expect(localStorage.getItem("workflow.authToken")).toBe("access-2");
  expect(localStorage.getItem("workflow.refreshToken")).toBe("refresh-2");
  expect(localStorage.getItem("workflow.user")).not.toBeNull();
  expect(expired).not.toHaveBeenCalled();
});
