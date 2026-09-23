import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from "../core/config.js";
import { HttpError, NetworkError, requestJson } from "../core/http.js";

/**
 * The student side of the session function. No sign-in: `join` returns a token and every other call
 * carries it. The publishable key is public by design (tables are locked, data goes through functions).
 */
export function callSession(body) {
  return requestJson(`${FUNCTIONS_URL}/session`, {
    method: "POST",
    body,
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
}

export const sessionApi = {
  /** name + class + the code from the board → { token, session, questions, answers } */
  join: (code, name, studentClass) => callSession({ action: "join", code, name, class: studentClass }),
  get: (token) => callSession({ action: "get", token }),
  save: (token, answers) => callSession({ action: "save", token, answers }),
  heartbeat: (token) => callSession({ action: "heartbeat", token }),
  event: (token, eventType, meta) => callSession({ action: "event", token, event_type: eventType, meta }),
  submit: (token, reason) => callSession({ action: "submit", token, reason }),
  result: (token) => callSession({ action: "result", token }),
  media: (token) => callSession({ action: "media", token }),
};

export { HttpError, NetworkError };

/** The session is gone (for example the database was cleaned): the student has to join again. */
export const isExpiredSession = (err) => err instanceof HttpError && (err.status === 401 || err.status === 404);
