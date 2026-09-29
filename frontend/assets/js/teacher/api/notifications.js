import { callStaffFunction } from "../../core/api.js";

/** Notification-bell calls (TASK-015, DEC-017). Every call is one POST { action, ... }. */
const call = (body) => callStaffFunction("notifications", { method: "POST", body });

export const notifications = {
  /** What needs attention right now: { kinds, essays, suspicious, account, backup, total, unread, read_at }. */
  list: () => call({ action: "list" }).then((r) => r.notifications),
  /** Opening the bell marks everything read and answers the same shape, so the screen repaints from one call. */
  markRead: () => call({ action: "mark_read" }).then((r) => r.notifications),
};
