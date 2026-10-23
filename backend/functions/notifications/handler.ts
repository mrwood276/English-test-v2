import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed } from "../_shared/errors.ts";
import { requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asEnum, asInt, asObject } from "../_shared/validate.ts";

export type Db = StaffDb & RpcDb;

const ACTIONS = [
  "list", // the bell: what needs attention, plus the unread count (DEC-017)
  "mark_read", // marks the bell opened; answers the same shape as `list`
] as const;

/**
 * The dashboard bell (TASK-015, DEC-017). One endpoint, POST { action, ... }.
 *
 * Notifications are computed at read time from data the other screens already show, so the bell can
 * never disagree with them; the only stored state is *when a person last opened the bell*. Every
 * signed-in staff member has a bell — essays and suspicious events are teacher business, backups and
 * new accounts interest admins — and the database function refuses deactivated accounts itself.
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const me = await requireStaff(req, db, ["teacher", "admin"]);
    const b = asObject(await readJson(req, 20_000));
    const action = asEnum(b.action, "action", ACTIONS);

    switch (action) {
      case "list":
        return {
          notifications: await callRpc(db, "list_notifications", {
            p_actor: me.userId,
            p_limit: asInt(b.limit ?? 50, "Limit", { min: 1, max: 200 }),
          }),
        };
      case "mark_read":
        return {
          notifications: await callRpc(db, "mark_notifications_read", {
            p_actor: me.userId,
          }),
        };
    }
  });
}
