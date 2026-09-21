import { h, mount, initials } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { startRouter } from "../router.js";
import { APP_BUILD } from "../../core/config.js";

const ROLE_LABEL = { teacher: "Teacher", admin: "Admin" };

const NAV = [
  { route: "#/dashboard", label: "Dashboard", icon: "dash" },
  { route: "#/questions", label: "Question bank", icon: "book" },
  { label: "Exams", icon: "doc" },
  { label: "Grading", icon: "check" },
  { label: "Results", icon: "chart" },
];

/** The signed-in shell. The menu matches the approved mockups; pages are added phase by phase. */
export function renderShell(root, ctx) {
  const { user } = ctx;
  const nav = h(
    "nav",
    { class: "nav", "aria-label": "Main" },
    NAV.map((item) =>
      item.route
        ? h("a", { href: item.route, "data-route": item.route }, icon(item.icon), item.label)
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
}
