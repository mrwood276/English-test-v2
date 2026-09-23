import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { sessionApi } from "../api.js";

/**
 * Join screen (mockup 1): name, class and the code from the board in one place (BR-03).
 * The name and class are typed freely; the server normalizes them, so "xii tkj a" and "XII TKJ A"
 * are the same student (BR-01, BR-09 of the design). The code box is one big field with wide letter
 * spacing, which reads like the separate boxes of the mockup but is far easier to type on a phone.
 */
export function renderJoin(root, { notice, onJoined }) {
  const errorBox = h("div", { class: "errcard", role: "alert", hidden: true });
  const noticeBox = notice ? h("div", { class: "errcard warn", role: "status" }, icon("alert"), h("span", {}, notice)) : null;

  const name = h("input", { class: "input", id: "student-name", type: "text", autocomplete: "name", autocapitalize: "words", required: true, maxlength: 80 });
  const klass = h("input", { class: "input", id: "student-class", type: "text", autocomplete: "off", autocapitalize: "characters", required: true, maxlength: 60 });
  const code = h("input", { class: "input code-input", id: "test-code", type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", inputmode: "latin", required: true, maxlength: 12, "aria-describedby": "code-hint" });
  const submit = h("button", { class: "btn block", type: "submit" }, "Start test");

  // Students type the code in any case and often with a stray space; the server does the same cleanup.
  code.addEventListener("input", () => {
    const clean = code.value.replace(/\s+/g, "").toUpperCase();
    if (code.value !== clean) code.value = clean;
  });

  function showError(message) {
    errorBox.replaceChildren(icon("alert"), h("span", {}, message));
    errorBox.hidden = false;
  }

  const form = h("form", { novalidate: true },
    h("div", { class: "field" }, h("label", { for: "student-name" }, "Full name"), name),
    h("div", { class: "field" },
      h("label", { for: "student-class" }, "Class"),
      klass,
      h("p", { class: "hint" }, "Type it the same way every time.")),
    h("div", { class: "field" },
      h("label", { for: "test-code" }, "Test code"),
      code,
      h("p", { class: "hint", id: "code-hint" }, "Your teacher writes it on the board.")),
    errorBox,
    submit);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    if (noticeBox) noticeBox.hidden = true;

    const nameValue = name.value.trim();
    const classValue = klass.value.trim();
    const codeValue = code.value.replace(/\s+/g, "").toUpperCase();
    if (nameValue.length < 2) return showError("Type your full name.");
    if (!classValue) return showError("Type your class.");
    if (codeValue.length < 4) return showError("Type the test code from the board.");

    submit.disabled = true;
    submit.textContent = "Checking the code…";
    try {
      const data = await sessionApi.join(codeValue, nameValue, classValue);
      await onJoined(data);
    } catch (err) {
      // Offline, or the server refused the join (wrong code, test closed, already taken…).
      showError(err.message || "Could not start the test. Please try again.");
      code.select();
    } finally {
      submit.disabled = false;
      submit.textContent = "Start test";
    }
  });

  mount(root,
    h("main", { class: "phone join" },
      h("div", { class: "pad" },
        h("div", { class: "brand-row", style: "margin-bottom:26px" }, h("span", { class: "bubble" }, "E"), h("b", {}, "English Daily Test")),
        h("h1", {}, "Join your test"),
        h("p", { class: "lead" }, "Type your name and class, then the code your teacher wrote on the board."),
        noticeBox,
        form,
        h("p", { class: "fine" }, "Your teacher can see your name, class, and score. Trouble joining? Ask your teacher."))));
  name.focus();
}
