import { h, mount, initials } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { startRouter } from "../router.js";
import { APP_BUILD } from "../../core/config.js";
import { results } from "../api/results.js";
import { notifications } from "../api/notifications.js";

const ROLE_LABEL = { teacher: "Teacher", admin: "Admin" };

const NAV = [
  { route: "#/dashboard", label: "Dashboard", icon: "dash" },
  { route: "#/questions", label: "Question bank", icon: "book" },
  { route: "#/exams", label: "Exams", icon: "doc" },
  { route: "#/grading", label: "Grading", icon: "check", badge: true },
  { route: "#/results", label: "Results", icon: "chart" },
  { route: "#/monitor", label: "Monitor", icon: "grid" },
];

// Accounts, the audit log and backups are admin jobs (design.md 1.2), so admins see three more menu items.
const ADMIN_NAV = [
  ...NAV,
  { route: "#/accounts", label: "Accounts", icon: "users" },
  { route: "#/audit", label: "Audit log", icon: "clock" },
  { route: "#/backups", label: "Backups", icon: "cloud" },
];

/** A short "3 min ago" for the bell rows; the badge stays honest without a clock widget. */
function timeAgo(value) {
  if (!value) return "";
  const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * The notification bell (TASK-015, DEC-017). It sits at the end of the brand row — outside the
 * menu, so the menu stays exactly the approved mockup — and shows what needs attention right now:
 * essays to grade and exams with suspicious events for everybody, the newest backup and newly
 * created accounts for admins. Opening the bell marks it read, so the badge only counts real news.
 * Returns the element; the caller places it (mount() replaces children, so the shell mounts once).
 */
function buildBell() {
  let open = false;

  // Its own class, not .pill.bad: a hidden badge early in the DOM must never answer a
  // querySelector('.pill.bad') that some screen's own warning pill is meant to match.
  const badge = h("span", { class: "notif-badge", hidden: true });
  const btn = h(
    "button",
    { id: "notif-bell", class: "bell-btn", type: "button", "aria-label": "Notifications", "aria-expanded": "false", title: "Notifications" },
    icon("bell"),
    badge,
  );
  const sub = h("span", { class: "hint" }, "");
  const body = h("div", { class: "notif-body" }, h("div", { class: "notif-empty" }, "Loading…"));
  const panel = h(
    "div",
    { class: "notif-panel", hidden: true },
    h("div", { class: "notif-head" }, h("strong", {}, "Notifications"), sub),
    body,
    h("div", { class: "hint notif-foot" }, "Email summaries are not switched on yet."),
  );
  const wrap = h("div", { class: "bell-wrap" }, btn, panel);

  // Rows carry their own pill classes (not .pill): the closed panel stays in the DOM, and a hidden
  // element must never answer a global querySelector('.pill.bad') meant for a screen's own warning.
  const row = (href, tone, pillText, title, detail, when) =>
    h(
      "a",
      { class: "notif-row", href },
      h("span", { class: `notif-pill notif-pill-${tone}` }, pillText),
      h("span", { class: "notif-main" }, h("strong", {}, title), h("span", { class: "notif-sub" }, detail)),
      h("span", { class: "hint notif-when" }, timeAgo(when)),
    );

  const kindHeading = (text) => h("div", { class: "notif-kind" }, text);

  /** Repaints badge and rows from one list answer. */
  const paint = (n) => {
    badge.textContent = String(n.unread);
    badge.hidden = !(n.unread > 0);
    badge.title = `${n.unread} unread notification${n.unread === 1 ? "" : "s"}`;
    sub.textContent = n.unread > 0 ? `${n.unread} unread` : "all read";

    const essays = n.kinds.essays || [];
    const suspicious = n.kinds.suspicious || [];
    const accounts = n.kinds.accounts || [];
    const backup = n.kinds.backup;
    const rows = [];

    if (essays.length > 0) rows.push(kindHeading("Essays to grade"));
    for (const e of essays) {
      rows.push(row(
        `#/grading/${e.exam_id}`, "warn", "Essay", e.title,
        `${e.waiting} waiting · ${e.student_name} (${e.student_class})`, e.updated_at,
      ));
    }

    if (suspicious.length > 0) rows.push(kindHeading("Exams worth a look"));
    for (const s of suspicious) {
      rows.push(row(
        `#/monitor/${s.exam_id}`, "bad", "Suspicious", s.title,
        `${s.events} event${s.events === 1 ? "" : "s"} · ${s.sessions} attempt${s.sessions === 1 ? "" : "s"}`, s.last_at,
      ));
    }

    if (backup || accounts.length > 0) rows.push(kindHeading("System"));
    if (backup) {
      rows.push(row(
        "#/backups", "neutral", "Backup", backup.kind === "automatic" ? "Nightly backup finished" : "Manual backup taken",
        backup.created_by_name ? `by ${backup.created_by_name}` : "by the nightly job", backup.created_at,
      ));
    }
    for (const a of accounts) {
      rows.push(row(
        "#/accounts", "ok", "New", a.full_name || a.email,
        `${a.role === "admin" ? "Admin" : "Teacher"} account · hand over the password`, a.created_at,
      ));
    }

    body.replaceChildren(
      ...(rows.length > 0
        ? rows
        : [h("div", { class: "notif-empty" }, "All quiet. Nothing needs your attention right now.")]),
    );
  };

  const paintProblem = () => {
    body.replaceChildren(h("div", { class: "notif-empty" }, "The bell could not be read. Try again in a moment."));
  };

  const load = async () => {
    try {
      paint(await notifications.list());
    } catch {
      paintProblem(); // the api layer already handles a signed-out session
    }
  };

  const setOpen = async (next) => {
    open = next;
    panel.hidden = !next;
    btn.setAttribute("aria-expanded", String(next));
    if (!next) return;
    // Opening the bell marks everything read; the same answer repaints the rows.
    try {
      paint(await notifications.markRead());
    } catch {
      paintProblem();
    }
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  document.addEventListener("click", (e) => {
    if (open && !wrap.contains(e.target)) setOpen(false);
  });
  // Navigating closes the bell and re-counts (grading an essay, taking a backup…).
  window.addEventListener("hashchange", () => {
    if (open) setOpen(false);
    load();
  });
  // A screen that grades something tells the bell too, so essays cannot go stale on screen.
  window.addEventListener("staff:results-changed", load);

  load();
  return wrap;
}

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
        h("div", { class: "brand" }, h("span", { class: "bubble" }, "E"), "English Daily Test", buildBell()),
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
