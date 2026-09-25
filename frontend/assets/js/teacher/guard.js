/**
 * Leave guard: a screen with unsaved work registers a function that asks the person whether to leave.
 * The router calls it before changing screens; closing the tab or reloading shows the browser's own warning.
 *
 * Two questions, two shapes:
 * - the async function is what the router asks when the person is leaving (`window.confirm`, a dialog, …);
 * - `unsaved` is a cheap synchronous predicate saying whether there is anything to lose at all.
 *
 * The predicate matters: registering the guard is not the same as having unsaved work (every editor
 * registers on sight), and the browser's own reload/close warning cannot await anything. Without it,
 * opening an editor and reloading asked "Leave site?" although nothing had been typed, and the router
 * rewrote the URL on every navigation away from a screen that had nothing to save.
 */
let guard = null;
let unsaved = () => true;

export const setLeaveGuard = (fn, hasUnsavedWork = () => true) => { guard = fn; unsaved = hasUnsavedWork; };
export const clearLeaveGuard = () => { guard = null; unsaved = () => true; };
export const getLeaveGuard = () => guard;

/** True only while a screen is guarding a change that is not saved. */
export const hasUnsavedChanges = () => (guard ? unsaved() : false);

window.addEventListener("beforeunload", (event) => {
  if (hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
