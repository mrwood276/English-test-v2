import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed } from "../_shared/errors.ts";
import { requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asEnum, asInt, asObject, asString, optional } from "../_shared/validate.ts";

export type Db = StaffDb & RpcDb;

const ACTIONS = [
  "list", // every recorded staff action, newest first (the admin viewer, TASK-015)
] as const;

/**
 * The admin's audit-log viewer (TASK-015). One endpoint, POST { action, ... }.
 * Reading the system's audit log is an admin job (design.md 1.2), so this is the one staff
 * endpoint a teacher cannot call. The work happens in the database function (DEC-004); this
 * endpoint is read-only: `list_audit_logs` reads the rows `write_audit` has been recording
 * since v2_08. The body key for the action filter is `filter_action` because `action` is
 * already the endpoint's own enum.
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    await requireStaff(req, db, ["admin"]);
    const b = asObject(await readJson(req, 20_000));
    const action = asEnum(b.action, "action", ACTIONS);

    switch (action) {
      case "list":
        return {
          logs: await callRpc(db, "list_audit_logs", {
            p_limit: optional(b.limit, (v) => asInt(v, "Limit", { min: 1, max: 200 })) ?? 50,
            p_offset: optional(b.offset, (v) => asInt(v, "Offset", { min: 0, max: 1_000_000 })) ?? 0,
            p_action: optional(b.filter_action, (v) => asString(v, "Action", { min: 1, max: 80 })) ?? null,
            p_entity_type: optional(b.entity_type, (v) => asString(v, "Entity type", { min: 1, max: 60 })) ?? null,
            p_days: optional(b.days, (v) => asInt(v, "Days", { min: 1, max: 3650 })) ?? null,
          }),
        };
    }
  });
}
