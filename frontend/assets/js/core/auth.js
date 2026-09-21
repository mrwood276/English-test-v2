import { AUTH_URL, SUPABASE_PUBLISHABLE_KEY, STAFF_SESSION_KEY } from "./config.js";
import { requestJson, HttpError } from "./http.js";

/**
 * Teacher/admin sign in through Supabase Auth (REST). The session is kept in sessionStorage,
 * so closing the tab signs the person out. It is validated by the server on every request.
 */

const baseHeaders = { apikey: SUPABASE_PUBLISHABLE_KEY };

export class SessionExpiredError extends Error {
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

function toSession(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    userId: data.user && data.user.id,
    email: data.user && data.user.email,
  };
}

export function loadSession() {
  try {
    const raw = sessionStorage.getItem(STAFF_SESSION_KEY);
    const s = raw && JSON.parse(raw);
    return s && s.accessToken && s.refreshToken ? s : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  sessionStorage.removeItem(STAFF_SESSION_KEY);
}

export async function signIn(email, password) {
  try {
    const data = await requestJson(`${AUTH_URL}/token?grant_type=password`, {
      method: "POST",
      headers: baseHeaders,
      body: { email, password },
    });
    const session = toSession(data);
    saveSession(session);
    return session;
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 429) throw new HttpError(429, "Too many attempts. Please wait a minute and try again.", err.code, err.body);
      if (err.status === 400 || err.status === 401 || err.code === "invalid_credentials") {
        throw new HttpError(400, "The email or password is not correct.", "invalid_credentials", err.body);
      }
    }
    throw err;
  }
}

async function refresh(session) {
  try {
    const data = await requestJson(`${AUTH_URL}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: baseHeaders,
      body: { refresh_token: session.refreshToken },
    });
    const next = toSession(data);
    saveSession(next);
    return next;
  } catch (err) {
    if (err instanceof HttpError) {
      clearSession();
      throw new SessionExpiredError();
    }
    throw err; // a network problem is not the same as an expired session
  }
}

/** Returns a usable access token, refreshing it shortly before it expires. */
export async function getAccessToken() {
  let session = loadSession();
  if (!session) throw new SessionExpiredError("Please sign in.");
  if (session.expiresAt - Math.floor(Date.now() / 1000) < 60) session = await refresh(session);
  return session.accessToken;
}

export async function signOut() {
  const session = loadSession();
  clearSession();
  if (!session) return;
  try {
    await requestJson(`${AUTH_URL}/logout`, {
      method: "POST",
      headers: { ...baseHeaders, Authorization: `Bearer ${session.accessToken}` },
    });
  } catch {
    /* already signed out locally; the token also expires by itself */
  }
}
