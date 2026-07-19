export function unwrap(response, fallback = null) {
  const payload = response?.data;
  if (payload?.success === false) {
    throw new Error(payload.message || "Request failed");
  }
  return payload?.data ?? fallback;
}

export function apiErrorMessage(error, fallback = "The request could not be completed.") {
  return error?.response?.data?.message || error?.message || fallback;
}

export function formatRelativeTime(value) {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(milliseconds = 0) {
  if (!milliseconds) return "0ms";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function formatTokens(value = 0) {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}K`;
}
