import { h, mount } from "../shared/dom.js";
import { loadSession, signOut, clearSession, SessionExpiredError } from "../core/auth.js";
import { whoAmI } from "../core/api.js";
import { HttpError, NetworkError } from "../core/http.js";
import { renderLogin } from "./screens/login.js";
import { renderShell } from "./screens/shell.js";

const root = document.getElementById("app");

async function showApp() {
  window.dispatchEvent(new Event("staff:signed-in")); // re-allow session-expired announcements (see core/api.js)
  const { user } = await whoAmI();
  renderShell(root, {
    user,
    onSignOut: async () => {
      await signOut();
      showLogin();
    },
  });
}

function showLogin(notice) {
  renderLogin(root, {
    notice,
    // If the account signs in but is not allowed here (or the check fails), do not leave a half-open session behind.
    onSuccess: async () => {
      try {
        await showApp();
      } catch (err) {
        await signOut();
        throw err;
      }
    },
  });
}

function showRetry(message) {
  const retry = h("button", { class: "btn", type: "button" }, "Try again");
  retry.addEventListener("click", boot);
  mount(root, h("main", { class: "login" }, h("div", { class: "login-card" }, h("h1", {}, "Can't connect"), h("p", { class: "lead" }, message), retry)));
}

// Any screen can end up with an expired session (see core/api.js); go back to sign in with an explanation.
window.addEventListener("staff:session-expired", (event) => showLogin(event.detail));

async function boot() {
  if (!loadSession()) return showLogin();
  try {
    await showApp();
  } catch (err) {
    if (err instanceof SessionExpiredError) return; // the listener above already showed the sign in screen
    if (err instanceof HttpError && err.status === 403) {
      await signOut();
      return showLogin(err.message);
    }
    if (err instanceof NetworkError) return showRetry(err.message);
    clearSession();
    showLogin(err.message || "Please sign in again.");
  }
}

boot();
