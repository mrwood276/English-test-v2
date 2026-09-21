import { renderDashboard } from "./screens/dashboard.js";
import { renderQuestionBank } from "./screens/questionBank.js";
import { renderQuestionEditor } from "./screens/questionEditor.js";
import { renderQuestionImport } from "./screens/questionImport.js";
import { getLeaveGuard, clearLeaveGuard } from "./guard.js";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const ROUTES = [
  { pattern: /^#\/dashboard$/, nav: "#/dashboard", title: "Dashboard", render: (c, ctx) => renderDashboard(c, ctx) },
  { pattern: /^#\/questions$/, nav: "#/questions", title: "Question bank", render: (c, ctx) => renderQuestionBank(c, ctx) },
  { pattern: /^#\/questions\/import$/, nav: "#/questions", title: "Import questions", render: (c, ctx) => renderQuestionImport(c, ctx) },
  { pattern: /^#\/questions\/new$/, nav: "#/questions", title: "New question", render: (c, ctx) => renderQuestionEditor(c, ctx, {}) },
  { pattern: new RegExp(`^#/questions/edit/(${UUID})$`), nav: "#/questions", title: "Edit question", render: (c, ctx, m) => renderQuestionEditor(c, ctx, { id: m[1].toLowerCase() }) },
];
const DEFAULT_HASH = "#/dashboard";

let stop = null;

function match(hash) {
  for (const route of ROUTES) {
    const m = route.pattern.exec(hash);
    if (m) return { route, m };
  }
  return null;
}

/** Tiny hash router. Only one router runs at a time. */
export function startRouter(container, nav, ctx) {
  if (stop) stop();
  let currentHash = "";

  const show = () => {
    const found = match(location.hash) || match(DEFAULT_HASH);
    const { route, m } = found;
    currentHash = location.hash;
    clearLeaveGuard();
    for (const link of nav.querySelectorAll("a[data-route]")) {
      const active = link.dataset.route === route.nav;
      link.classList.toggle("on", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    container.replaceChildren();
    container.dataset.render = String((Number(container.dataset.render) || 0) + 1);
    document.title = `${route.title} | English Daily Test`;
    route.render(container, ctx, m);
  };

  const onChange = async () => {
    const guard = getLeaveGuard();
    if (guard && location.hash !== currentHash) {
      const target = location.hash;
      history.replaceState(null, "", currentHash || "#/dashboard"); // stay where we were while asking (no hashchange fires)
      if (!(await guard())) return;
      clearLeaveGuard();
      location.hash = target; // fires hashchange again, now without a guard
      return;
    }
    show();
  };

  window.addEventListener("hashchange", onChange);
  stop = () => window.removeEventListener("hashchange", onChange);
  show();
}
