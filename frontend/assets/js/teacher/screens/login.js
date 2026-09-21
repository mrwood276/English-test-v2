import { h, mount } from "../../shared/dom.js";
import { signIn } from "../../core/auth.js";

/** Sign in screen. `onSuccess` runs after Supabase accepts the email and password. */
export function renderLogin(root, { notice, onSuccess }) {
  const errorBox = h("div", { class: "notice error", role: "alert", hidden: true });
  const noticeBox = notice ? h("div", { class: "notice info", role: "status" }, notice) : null;

  const email = h("input", { class: "input", id: "email", type: "email", name: "email", autocomplete: "username", inputmode: "email", autocapitalize: "none", spellcheck: "false", required: true });
  const password = h("input", { class: "input", id: "password", type: "password", name: "password", autocomplete: "current-password", required: true });
  const toggle = h("button", { class: "input-toggle", type: "button", "aria-pressed": "false" }, "Show");
  const submit = h("button", { class: "btn block", type: "submit" }, "Sign in");

  toggle.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(show));
  });

  function showError(message, field) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    email.classList.toggle("invalid", field === "email");
    password.classList.toggle("invalid", field === "password");
    if (field) (field === "email" ? email : password).focus();
  }

  const form = h(
    "form",
    { novalidate: true },
    h("div", { class: "field" }, h("label", { for: "email" }, "Email"), email),
    h("div", { class: "field" }, h("label", { for: "password" }, "Password"), h("div", { class: "input-wrap" }, password, toggle)),
    submit,
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    email.classList.remove("invalid");
    password.classList.remove("invalid");

    const emailValue = email.value.trim();
    if (!emailValue) return showError("Enter your email.", "email");
    if (!password.value) return showError("Enter your password.", "password");

    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      await signIn(emailValue, password.value);
      await onSuccess();
    } catch (err) {
      password.value = "";
      showError(err.message || "Could not sign in. Please try again.", err.code === "invalid_credentials" ? "password" : undefined);
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });

  mount(
    root,
    h(
      "main",
      { class: "login" },
      h(
        "div",
        { class: "login-card" },
        h("div", { class: "brand" }, h("span", { class: "bubble" }, "E"), "English Daily Test"),
        h("h1", {}, "Teacher sign in"),
        h("p", { class: "lead" }, "Use the email and password for your teacher or admin account."),
        noticeBox,
        errorBox,
        form,
      ),
    ),
  );
  email.focus();
}
