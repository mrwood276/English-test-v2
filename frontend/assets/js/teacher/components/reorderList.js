/**
 * Reordering a list with one grip per row: the grip drags the row, the same grip moves it with the arrow
 * keys, and a button can move it one place too. It was written for the exam editor's question list (DEC-036)
 * and is shared from here on, so the question bank's own ordered lists use this instead of a second
 * implementation (`.ai/00_AI_RULES.md` §4).
 *
 *   const reorder = enableReorder(listEl, {
 *     note,                                // a polite live region to speak the move through
 *     noun: "answer",                      // what one row is called in that message
 *     describe: (row) => "…",              // the row's own name for the message (optional)
 *     onOrder: (rows) => { paint() },      // the rows in their new order; repaint the list from your state
 *   });
 *
 * The caller keeps the ids, the objects and the state; this only moves elements, so the same control works
 * for a list of records with ids, for the question editor's answers (which have no ids at all) and for the
 * attached files. `onOrder` must repaint the list synchronously — everything below reads the live children.
 *
 * Every listener is delegated from the list element, so rows can be rebuilt freely and no row ever needs to
 * be told about this. A row's grip is any descendant with class `grip`; a row that must not move (a file
 * still uploading) simply has no grip, and the rows on either side close up around it. A button that moves a
 * row one place carries `data-move="up" | "down" | "first" | "last"`.
 */
export function enableReorder(listEl, { note, onOrder, describe = () => "", noun = "item" } = {}) {
  let drag = null;
  let keyHandler = null;

  const rows = () => [...listEl.children].filter((el) => !!el.querySelector(".grip"));
  const centre = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  const say = (text) => { if (note) note.textContent = text; };
  const nameOf = (row) => describe(row) || `That ${noun}`;

  /** The direct child of the list that holds this node — the "row" everything here talks about. */
  function rowOf(node) {
    let el = node;
    while (el && el.parentElement && el.parentElement !== listEl) el = el.parentElement;
    return el && el.parentElement === listEl ? el : null;
  }

  /** Put the keyboard back on the row that moved, so pressing the same key twice moves it twice. */
  function focusAt(index, focusSel = ".grip") {
    const list = rows();
    const row = list[Math.min(Math.max(index, 0), list.length - 1)];
    if (!row) return;
    const target = row.querySelector(focusSel) || row.querySelector(".grip");
    if (target && !target.disabled) target.focus();
    else if (target && target.disabled) { const grip = row.querySelector(".grip"); if (grip) grip.focus(); }
  }

  /** Move a row to another place in the list and hand the new order to the caller. */
  function move(from, to, { focusSel = ".grip" } = {}) {
    const list = rows();
    if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return false;
    const row = list[from];
    const message = `${nameOf(row)} is now ${noun} ${to + 1} of ${list.length}.`;
    if (to < from) listEl.insertBefore(row, list[to]);
    else list[to].after(row);
    onOrder([...rows()]);
    say(message);
    focusAt(to, focusSel);
    return true;
  }

  function detach() {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    document.removeEventListener("pointercancel", onDragEnd);
    if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
    if (drag) {
      drag.row.classList.remove("dragging");
      listEl.classList.remove("reordering");
    }
  }

  // ---------- dragging ----------
  // The row under the pointer moves for real (the list is the preview) and the caller's state catches up on
  // release. The move and the release are watched on the document, not on the grip: the pointer leaves the
  // grip at once and the rows underneath move as it goes, so a grip-local listener would miss most of it.
  function startDrag(e, grip) {
    const row = rowOf(grip);
    if (!row || rows().length < 2) return;
    drag = { row, pointerId: e.pointerId, order: rows() };
    row.classList.add("dragging");
    listEl.classList.add("reordering");
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
    document.addEventListener("pointercancel", onDragEnd);
    keyHandler = (ev) => { if (ev.key === "Escape" && drag) { ev.preventDefault(); cancel(); } };
    document.addEventListener("keydown", keyHandler);
    e.preventDefault();   // do not let the press start a text selection or the browser's own drag
    grip.focus();
    say(`Picked up ${nameOf(row)}.`);
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const others = rows().filter((el) => el !== drag.row);
    const before = others.find((el) => e.clientY < centre(el));
    if (before) listEl.insertBefore(drag.row, before);
    else {
      const last = others[others.length - 1];
      if (last) last.after(drag.row);
      else listEl.prepend(drag.row);
    }
  }

  function onDragEnd(e) { if (drag && e.pointerId === drag.pointerId) drop(); }

  function drop() {
    const { row, order } = drag;
    drag = null;
    detach();
    const list = rows();
    const at = list.indexOf(row);
    const moved = list.some((el, i) => el !== order[i]);
    const message = moved
      ? `${nameOf(row)} is now ${noun} ${at + 1} of ${list.length}.`
      : `${nameOf(row)} stayed where it was.`;
    onOrder([...list]);
    say(message);
    focusAt(at);
  }

  /** Escape during a drag: the caller's state never changed, so handing the starting order back restores it. */
  function cancel() {
    const { row, order } = drag;
    drag = null;
    detach();
    onOrder([...order]);
    say("Move cancelled.");
    focusAt(order.indexOf(row));
  }

  /** A rebuild is about to replace every row: forget any drag in flight (no repaint, no announcement). */
  function reset() {
    if (!drag) return;
    drag = null;
    detach();
  }

  // ---------- delegation ----------
  listEl.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest(".grip");
    if (!grip || grip.disabled || e.button > 0 || rows().length < 2) return;
    startDrag(e, grip);
  });

  listEl.addEventListener("keydown", (e) => {
    const grip = e.target.closest(".grip");
    if (!grip || grip.disabled) return;
    const list = rows();
    const at = list.indexOf(rowOf(grip));
    const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();   // an arrow key at either end must not scroll the page instead
    move(at, to);
  });

  listEl.addEventListener("click", (e) => {
    const button = e.target.closest("[data-move]");
    if (!button || button.disabled) return;
    const which = button.dataset.move;
    const list = rows();
    const at = list.indexOf(rowOf(button));
    const to = { up: at - 1, down: at + 1, first: 0, last: list.length - 1 }[which];
    if (to === undefined) return;
    move(at, to, { focusSel: `[data-move='${which}']` });
  });

  return { move, reset };
}
