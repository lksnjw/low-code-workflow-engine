import { apiClient } from "../config/axios";

function persistSession(session) {
  if (session?.accessToken) {
    localStorage.setItem("workflow.authToken", session.accessToken);
  }
  if (session?.refreshToken) {
    localStorage.setItem("workflow.refreshToken", session.refreshToken);
  }
  if (session?.user) {
    localStorage.setItem("workflow.user", JSON.stringify(session.user));
  }
  return session;
}

export const authService = {
  async login(credentials) {
    const response = await apiClient.post("/auth/login", credentials);
    return persistSession(response.data.data);
  },

  async register(payload) {
    const response = await apiClient.post("/auth/register", payload);
    return persistSession(response.data.data);
  },

  async me() {
    const response = await apiClient.get("/auth/me");
    return response.data.data;
  },

  async refresh() {
    const refreshToken = localStorage.getItem("workflow.refreshToken");
    const response = await apiClient.post("/auth/refresh", { refreshToken });
    return persistSession(response.data.data);
  },

  async forgotPassword(email) {
    const response = await apiClient.post("/auth/forgot-password", { email });
    return response.data.data;
  },

  async resetPassword(token, password) {
    const response = await apiClient.post("/auth/reset-password", { token, password });
    return response.data.data;
  },

  async verifyEmail(token) {
    const response = await apiClient.post("/auth/verify-email", { token });
    return response.data.data;
  },

  async logout() {
    const refreshToken = localStorage.getItem("workflow.refreshToken");
    await apiClient.post("/auth/logout", { refreshToken }).catch(() => null);
    localStorage.removeItem("workflow.authToken");
    localStorage.removeItem("workflow.refreshToken");
    localStorage.removeItem("workflow.user");
  },

  async oauthAuthorize(provider) {
    const response = await apiClient.get(`/auth/oauth/${provider}/authorize`);
    return response.data.data;
  },

  async twoFactorVerify(code) {
    const response = await apiClient.post("/auth/2fa/verify", { code });
    return response.data.data;
  },
};
