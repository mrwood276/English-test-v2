import { h, mount, initials } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { startRouter } from "../router.js";
import { APP_BUILD } from "../../core/config.js";
import { results } from "../api/results.js";

const ROLE_LABEL = { teacher: "Teacher", admin: "Admin" };

const NAV = [
  { route: "#/dashboard", label: "Dashboard", icon: "dash" },
  { route: "#/questions", label: "Question bank", icon: "book" },
  { route: "#/exams", label: "Exams", icon: "doc" },
  { route: "#/grading", label: "Grading", icon: "check", badge: true },
  { route: "#/results", label: "Results", icon: "chart" },
  { route: "#/monitor", label: "Monitor", icon: "grid" },
];

// The audit log and backups are admin jobs (design.md 1.2), so admins see two more menu items.
const ADMIN_NAV = [
  ...NAV,
  { route: "#/audit", label: "Audit log", icon: "clock" },
  { route: "#/backups", label: "Backups", icon: "cloud" },
];

/** The signed-in shell. The menu matches the approved mockups. */
export function renderShell(root, ctx) {
  const { user } = ctx;

  /** How many essays still wait; the badge stays quiet until there is something to do. */
  const badge = h("span", { class: "pill warn nav-badge", hidden: true });
  const refreshBadge = async () => {
    try {
      const n = await results.pending();
      badge.textContent = String(n);
      badge.hidden = !(n > 0);
      badge.title = `${n} ${n === 1 ? "essay" : "essays"} waiting to be graded`;
    } catch {
      badge.hidden = true; // a signed-out session is handled by api.js; the badge just goes quiet
    }
  };

  const nav = h(
    "nav",
    { class: "nav", "aria-label": "Main" },
    (user.role === "admin" ? ADMIN_NAV : NAV).map((item) =>
      item.route
        ? h("a", { href: item.route, "data-route": item.route }, icon(item.icon), item.label, item.badge ? badge : null)
        : h("span", { class: "item", "aria-disabled": "true", title: "Coming in a later phase" }, icon(item.icon), item.label, h("span", { class: "soon pill" }, "Soon")),
    ),
  );
  const content = h("main", { class: "main", id: "content", tabindex: "-1" });

  mount(
    root,
    h(
      "div",
      { class: "shell" },
      h(
        "aside",
        { class: "side" },
        h("div", { class: "brand" }, h("span", { class: "bubble" }, "E"), "English Daily Test"),
        nav,
        h("div", { class: "me" }, h("span", { class: "avatar" }, initials(user.fullName)), h("div", {}, h("strong", {}, user.fullName), h("div", { class: "hint" }, ROLE_LABEL[user.role] || user.role))),
        h("div", { class: "build hint", "data-build": "" }, `Build: ${APP_BUILD}`),
      ),
      content,
    ),
  );

  startRouter(content, nav, ctx);
  refreshBadge();
  window.addEventListener("hashchange", refreshBadge);
  // A screen that grades something tells the menu, so the badge cannot go stale.
  window.addEventListener("staff:results-changed", refreshBadge);
}
