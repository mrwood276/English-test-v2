import { h, mount } from "../../shared/dom.js";

const ROLE_LABEL = { teacher: "Teacher", admin: "Admin" };

export function renderDashboard(container, { user, onSignOut }) {
  const signOut = h("button", { class: "btn ghost", type: "button" }, "Sign out");
  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    await onSignOut();
  });

  mount(
    container,
    h("h1", {}, `Welcome, ${user.fullName}`),
    h("p", { class: "sub" }, "Your question bank is ready. Exams, grading, and results arrive in the next phases."),
    h(
      "section",
      { class: "card", "aria-label": "Connection check" },
      h("h2", {}, "Connection check"),
      h("div", { class: "kv" }, h("span", {}, "Signed in as"), h("strong", {}, ROLE_LABEL[user.role] || user.role)),
      h("div", { class: "kv" }, h("span", {}, "Server"), h("span", { class: "pill ok" }, "Connected")),
      h("div", { style: "margin-top:14px" }, signOut),
    ),
  );
}
