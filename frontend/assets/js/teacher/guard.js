/**
 * Leave guard: a screen with unsaved work registers a function that asks the person whether to leave.
 * The router calls it before changing screens; closing the tab or reloading shows the browser's own warning.
 */
let guard = null;

export const setLeaveGuard = (fn) => { guard = fn; };
export const clearLeaveGuard = () => { guard = null; };
export const getLeaveGuard = () => guard;

window.addEventListener("beforeunload", (event) => {
  if (guard) {
    event.preventDefault();
    event.returnValue = "";
  }
});
