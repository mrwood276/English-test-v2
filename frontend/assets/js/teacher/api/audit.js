import { callStaffFunction } from "../../core/api.js";

/** Audit-log calls (admin only, TASK-015). Every call is one POST { action, ... } to the audit function. */
const call = (body) => callStaffFunction("audit", { method: "POST", body });

export const audit = {
  /** Every recorded staff action, newest first: { total, rows }. */
  list: ({ limit = 25, offset = 0, filterAction = null, entityType = null, days = null } = {}) =>
    call({ action: "list", limit, offset, filter_action: filterAction, entity_type: entityType, days }).then((r) => r.logs),
};
