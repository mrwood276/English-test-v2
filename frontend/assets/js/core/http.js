import { REQUEST_TIMEOUT_MS } from "./config.js";

/** The server answered with an error. `message` is safe to show to the person. */
export class HttpError extends Error {
  constructor(status, message, code, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** The server could not be reached, or took too long. */
export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
}

/** fetch + JSON with a timeout and friendly errors. */
export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new NetworkError(
      err && err.name === "AbortError"
        ? "The server took too long to answer. Please try again."
        : "Could not reach the server. Check your internet connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const message = (data && (data.error || data.msg || data.error_description)) || `Something went wrong (${res.status}).`;
    throw new HttpError(res.status, String(message), data && (data.code || data.error_code), data);
  }
  return data;
}
