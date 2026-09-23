/**
 * Students have no account, so a test session is a capability: the server hands the browser a token
 * that only that browser holds. A leaked session id alone must not be enough to read or write
 * another student's answers, so the token is `<session id>.<signature>`:
 *
 *   signature = base64url(HMAC-SHA256(key, "session:" + session id))
 *
 * The key never leaves the server (SESSION_TOKEN_SECRET, or the service role key already available
 * to every function). It replaces a column in the database: nothing secret is stored at rest, and
 * the id can never be guessed from the token.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(sessionId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`session:${sessionId}`));
  return base64url(new Uint8Array(mac));
}

export async function signSessionToken(sessionId: string, secret: string): Promise<string> {
  return `${sessionId}.${await signature(sessionId, secret)}`;
}

/** Returns the session id when the token is really ours, otherwise null. */
export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  if (!UUID_RE.test(id)) return null;
  const expected = await signature(id, secret);
  const given = token.slice(dot + 1);
  if (expected.length !== given.length) return null;
  let diff = 0; // compare every character so the answer does not leak through timing
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? id : null;
}

export function sessionTokenSecret(): string {
  const secret = Deno.env.get("SESSION_TOKEN_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("Missing SESSION_TOKEN_SECRET (and SUPABASE_SERVICE_ROLE_KEY)");
  return secret;
}
