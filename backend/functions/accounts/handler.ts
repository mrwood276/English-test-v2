import { handle, readJson } from "../_shared/http.ts";
import { ApiError, badRequest, methodNotAllowed } from "../_shared/errors.ts";
import { requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asBool, asEmail, asEnum, asObject, asPlain, asString, asUuid, optional } from "../_shared/validate.ts";

export type Db = StaffDb & RpcDb & AccountDb;

/** The Auth Admin API calls this endpoint needs, declared so the tests can stand in for the sign-in service. */
export interface AccountDb {
  auth: {
    admin: {
      createUser(input: { email: string; password: string; email_confirm: boolean; user_metadata: Record<string, unknown> }): PromiseLike<
        { data: { user: { id: string } | null } | null; error: { message: string } | null }
      >;
      updateUserById(id: string, input: { password: string }): PromiseLike<
        { data: unknown; error: { message: string } | null }
      >;
      deleteUser(id: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

export const ROLES = ["teacher", "admin"] as const;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 72;
const ACTIONS = ["list", "create", "update", "password"] as const;

/**
 * User management (TASK-015, design.md's User Management module): an admin creates a teacher's or another
 * admin's account, renames them, changes their role, deactivates them, or sets a new password to hand over.
 *
 * The owner's decision (DEC-031): the admin types the email and a temporary password and gives it to the
 * person, so nothing here depends on mail delivery; and an account is **deactivated, never deleted** —
 * its profile is what the audit trail and the rows it created point at.
 *
 * The two halves belong to two different systems, so the split is: this function calls the **Auth Admin
 * API** (creating the login, changing a password — only the service role may do that), and the **database**
 * keeps the bookkeeping and the rules that must never break (`record_account`, `update_account`,
 * `record_account_password`: who may act, nobody changes their own role, the last active admin stays).
 * If the database refuses after the login was created, the login is taken back out — a person who cannot
 * sign in and cannot be seen in the list is the one state worth going out of the way to avoid.
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const me = await requireStaff(req, db, ["admin"]);
    const b = asObject(await readJson(req, 20_000));
    const action = asEnum(b.action, "action", ACTIONS);

    switch (action) {
      case "list":
        return { accounts: await callRpc(db, "list_accounts") };

      case "create": {
        const email = asEmail(b.email, "Email");
        const fullName = asPlain(b.full_name, "Full name", { min: 1, max: 80 });
        const role = asEnum(b.role, "Role", ROLES);
        const password = asString(b.password, "Password", { min: MIN_PASSWORD, max: MAX_PASSWORD, trim: false });

        // Confirmed on creation: the admin is standing next to the person and knows the address is right
        // (there is no working mailer on the free plan — see docs/sql-accounts.md).
        const { data, error } = await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        });
        if (error || !data?.user) throw authProblem(error?.message, `creating ${email}`);
        const id = data.user.id;

        try {
          const account = await callRpc(db, "record_account", {
            p_id: id,
            p_email: email,
            p_full_name: fullName,
            p_role: role,
            p_actor: me.userId,
          });
          return { account };
        } catch (err) {
          await db.auth.admin.deleteUser(id);
          throw err;
        }
      }

      case "update": {
        const id = asUuid(b.id, "id");
        const fullName = optional(b.full_name, (v) => asPlain(v, "Full name", { min: 1, max: 80 })) ?? null;
        const role = optional(b.role, (v) => asEnum(v, "Role", ROLES)) ?? null;
        const isActive = optional(b.is_active, (v) => asBool(v, "Active")) ?? null;
        if (fullName === null && role === null && isActive === null) {
          throw badRequest("There is nothing to change.");
        }
        return {
          account: await callRpc(db, "update_account", {
            p_id: id,
            p_full_name: fullName,
            p_role: role,
            p_is_active: isActive,
            p_actor: me.userId,
          }),
        };
      }

      case "password": {
        const id = asUuid(b.id, "id");
        const password = asString(b.password, "Password", { min: MIN_PASSWORD, max: MAX_PASSWORD, trim: false });
        const { error } = await db.auth.admin.updateUserById(id, { password });
        if (error) throw authProblem(error.message, "setting a password");
        // The audit entry says a password was set and by whom; the password itself never reaches the database.
        return await callRpc(db, "record_account_password", { p_id: id, p_actor: me.userId });
      }
    }
  });
}

/** Turns what the sign-in service says into something a person can act on; unknown problems stay hidden. */
function authProblem(message: string | undefined, doing: string): Error {
  const m = (message ?? "").toLowerCase();
  if (m.includes("already registered") || m.includes("already been registered") || m.includes("user already exists")) {
    return badRequest("An account with this email address already exists.");
  }
  if (m.includes("password")) {
    return badRequest(`A password needs between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.`);
  }
  if (m.includes("email")) return badRequest("That email address cannot be used.");
  console.error(`accounts: ${doing} failed: ${message}`);
  return new ApiError(500, "internal_error", "Something went wrong. Please try again.");
}
