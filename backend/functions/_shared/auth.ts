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

/** The header the scheduled housekeeping job sends its key in. */
export const HOUSEKEEPING_HEADER = "x-housekeeping-key";

/** Compares two secrets without short-circuiting and without leaking their length through timing. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * True when the caller is the scheduled housekeeping job instead of a signed-in person.
 * The key lives only in this function's secrets and in Supabase Vault — never in this repository — and it
 * opens exactly one action (today: the unused-file purge), because a machine has no `profiles` row and
 * must not be able to do anything a person does. With no key configured the answer is always false.
 */
export async function isScheduledJob(req: Request): Promise<boolean> {
  const expected = Deno.env.get("HOUSEKEEPING_KEY");
  const presented = req.headers.get(HOUSEKEEPING_HEADER);
  if (!expected || !presented) return false;
  return await sameSecret(presented, expected);
}
