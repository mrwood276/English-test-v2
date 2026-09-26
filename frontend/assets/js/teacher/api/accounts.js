import { callStaffFunction } from "../../core/api.js";

/** Account calls (admin only, TASK-015). Every call is one POST { action, ... } to the accounts function. */
const call = (body) => callStaffFunction("accounts", { method: "POST", body });

export const accounts = {
  /** Every staff account: { total, rows: [{ id, email, full_name, role, is_active, created_at, last_sign_in_at }] }. */
  list: () => call({ action: "list" }).then((r) => r.accounts),

  /** Creates the login and the profile: { account }. `password` is the temporary one the admin hands over. */
  create: ({ email, fullName, role, password }) =>
    call({ action: "create", email, full_name: fullName, role, password }),

  /** Renames, changes the role or activates/deactivates: { account }. Only what is passed is changed. */
  update: (id, patch) => call({ action: "update", id, ...patch }),

  /** Sets a new password for somebody (they can sign in with it immediately). */
  setPassword: (id, password) => call({ action: "password", id, password }),

  /** The shortest password the server accepts, so the screen can say so before the call. */
  minPassword: 8,
};
