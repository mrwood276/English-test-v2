import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Database client with the service role. It bypasses RLS, so it must only be used inside Edge Functions,
 * after the caller has been checked (requireStaff for staff endpoints, validation for student endpoints).
 */
export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
