import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { HttpError, requestJson } from "./http.js";
import { clearSession, getAccessToken, SessionExpiredError } from "./auth.js";

/** Calls an Edge Function as the signed-in teacher/admin. A 401 means the session is over. */
let sessionExpiredAnnounced = false;
export async function callStaffFunction(name, { method = "GET", body } = {}) {
  try {
    const token = await getAccessToken();
    return await requestJson(`${FUNCTIONS_URL}/${name}`, {
      method,
      body,
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    let final = err;
    if (err instanceof HttpError && err.status === 401) {
      clearSession();
      final = new SessionExpiredError();
    }
    // Any screen can be showing when a session ends; the app listens for this and goes back to sign in.
    // Announce it once per signed-out period: background work that runs after the session was cleared
    // (a debounced check, a slow upload) would otherwise fire again and replace the first notice.
    if (final instanceof SessionExpiredError && !sessionExpiredAnnounced) {
      sessionExpiredAnnounced = true;
      // deno-lint-ignore no-window no-window-prefix
      window.addEventListener(
        "staff:signed-in",
        () => (sessionExpiredAnnounced = false),
        { once: true },
      );
      // deno-lint-ignore no-window no-window-prefix
      window.dispatchEvent(
        new CustomEvent("staff:session-expired", { detail: final.message }),
      );
    }
    throw final;
  }
}

export const whoAmI = () => callStaffFunction("auth-me");
