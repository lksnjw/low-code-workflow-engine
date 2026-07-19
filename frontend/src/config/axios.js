import axios from "axios";
import { appConfig } from "./app";

export const apiClient = axios.create({
  baseURL: appConfig.apiBaseUrl,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Attach Bearer token to every request
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("workflow.authToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Track whether a token refresh is already in flight
let isRefreshing = false;
let failedQueue = [];

function processQueue(error, token = null) {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve(token);
    }
  });
  failedQueue = [];
}

// 401 interceptor — attempt silent token refresh, then replay request
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (
      error?.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.startsWith("/auth/") &&
      localStorage.getItem("workflow.refreshToken")
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = localStorage.getItem("workflow.refreshToken");
        const refreshResponse = await apiClient.post("/auth/refresh", { refreshToken });
        const newToken = refreshResponse.data?.data?.accessToken;
        if (newToken) {
          localStorage.setItem("workflow.authToken", newToken);
          apiClient.defaults.headers.common.Authorization = `Bearer ${newToken}`;
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          processQueue(null, newToken);
          return apiClient(originalRequest);
        }
      } catch (refreshError) {
        processQueue(refreshError, null);
        // Refresh failed — clear session and redirect to login
        localStorage.removeItem("workflow.authToken");
        localStorage.removeItem("workflow.refreshToken");
        localStorage.removeItem("workflow.user");
        // Dispatch a custom event so the AuthProvider can react
        window.dispatchEvent(new CustomEvent("auth:expired"));
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);
