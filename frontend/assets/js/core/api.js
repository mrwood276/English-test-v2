import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { requestJson, HttpError } from "./http.js";
import { getAccessToken, clearSession, SessionExpiredError } from "./auth.js";

/** Calls an Edge Function as the signed-in teacher/admin. A 401 means the session is over. */
export async function callStaffFunction(name, { method = "GET", body } = {}) {
  try {
    const token = await getAccessToken();
    return await requestJson(`${FUNCTIONS_URL}/${name}`, {
      method,
      body,
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    let final = err;
    if (err instanceof HttpError && err.status === 401) {
      clearSession();
      final = new SessionExpiredError();
    }
    // Any screen can be showing when a session ends; the app listens for this and goes back to sign in.
    if (final instanceof SessionExpiredError) {
      window.dispatchEvent(new CustomEvent("staff:session-expired", { detail: final.message }));
    }
    throw final;
  }
}

export const whoAmI = () => callStaffFunction("auth-me");
