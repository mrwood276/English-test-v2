import { callStaffFunction } from "../../core/api.js";

/** Backup calls (admin only, TASK-015). Every call is one POST { action, ... } to the backups function. */
const call = (body) => callStaffFunction("backups", { method: "POST", body });

export const backups = {
  /** The stored copies, newest first: { total, rows }. */
  list: ({ limit = 50, offset = 0 } = {}) => call({ action: "list", limit, offset }).then((r) => r.backups),

  /** Makes a manual copy now and stores it: { backup, files, media_included, media_note, pruned }. */
  create: () => call({ action: "create" }),

  /** A short-lived link to download one archive: { url, name, expires_in }. */
  download: (id) => call({ action: "download", id }),

  /** Removes the row and the file. */
  remove: (id) => call({ action: "delete", id }),
};
