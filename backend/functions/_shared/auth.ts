import { forbidden, unauthorized } from "./errors.ts";

export type StaffRole = "teacher" | "admin";

export interface StaffContext {
  userId: string;
  role: StaffRole;
  fullName: string;
}

/** The part of the database client this module needs, so it can be tested without a database. */
export interface StaffDb {
  auth: { getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }> };
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: { id: string; full_name: string; role: StaffRole; is_active: boolean } | null; error: { message: string } | null }>;
      };
    };
  };
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Checks the signed-in person and their role.
 * The token is verified by Supabase Auth; the role always comes from the profiles table, never from the token.
 */
export async function requireStaff(req: Request, db: StaffDb, allowed: readonly StaffRole[] = ["teacher", "admin"]): Promise<StaffContext> {
  const token = bearerToken(req);
  if (!token) throw unauthorized();

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw unauthorized("Your session has expired. Please sign in again.");

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) throw new Error(`profile lookup failed: ${profileError.message}`);
  if (!profile || !profile.is_active) throw forbidden("This account does not have access.");
  if (!allowed.includes(profile.role)) throw forbidden();

  return { userId: profile.id, role: profile.role, fullName: profile.full_name };
}
