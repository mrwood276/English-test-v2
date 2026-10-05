/**
 * Students have no account, so a test session is a capability: the server hands the browser a token
 * that only that browser holds. A leaked session id alone must not be enough to read or write
 * another student's answers, so the token is `<session id>.<exp>.<signature>`:
 *
 *   exp       = base64url(8-byte big-endian Unix timestamp, session ends_at + 2 min grace)
 *   signature = base64url(HMAC-SHA256(key, "session:" + session id + ":" + exp))
 *
 * The key never leaves the server (SESSION_TOKEN_SECRET, or the service role key already available
 * to every function). It replaces a column in the database: nothing secret is stored at rest, and
 * the id can never be guessed from the token.
 *
 * The expiry is refreshed on every accepted call (join, get, save, event, media) so an active
 * student never hits it. A token from a closed/finished exam can still show the student's own
 * result (if that stays the rule) but cannot fetch the snapshot or write answers.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRACE_SECONDS = 120; // matches BR-20 tolerance used in SQL (ends_at + 2 min)

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function base64urlDecode(str: string): Uint8Array {
  // url-safe alphabet back to the standard one FIRST, then pad. (The first version applied the
  // replacements to the padding instead of the text, so any expiry containing "-" or "_" failed.)
  const standard = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeExp(exp: number): string {
  // 8-byte big-endian Unix timestamp
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(exp), false);
  return base64url(new Uint8Array(buf));
}

function decodeExp(expB64: string): number {
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(expB64);
  } catch {
    return 0; // a garbled expiry is an invalid token, not a server error
  }
  if (bytes.length !== 8) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  return Number(view.getBigUint64(0, false));
}

async function signature(
  sessionId: string,
  exp: number,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expB64 = encodeExp(exp);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`session:${sessionId}:${expB64}`),
  );
  return base64url(new Uint8Array(mac));
}

/** Sign a session token with an explicit expiry (Unix seconds). */
export async function signSessionToken(
  sessionId: string,
  secret: string,
  expiresAt: number,
): Promise<string> {
  const expB64 = encodeExp(expiresAt);
  return `${sessionId}.${expB64}.${await signature(
    sessionId,
    expiresAt,
    secret,
  )}`;
}

/**
 * Verify a session token and return the session id when it is really ours and not expired,
 * otherwise null.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, expB64, givenSig] = parts;
  if (!UUID_RE.test(id)) return null;
  const exp = decodeExp(expB64);
  if (exp === 0 || exp < Date.now() / 1000) return null; // expired
  const expected = await signature(id, exp, secret);
  if (expected.length !== givenSig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ givenSig.charCodeAt(i);
  }
  return diff === 0 ? id : null;
}

/** Compute the token expiry for a session (ends_at + 2 min grace). */
export function computeTokenExpiry(endsAt: string | Date): number {
  const ends = new Date(endsAt).getTime();
  if (Number.isNaN(ends)) return 0;
  return Math.floor((ends + GRACE_SECONDS * 1000) / 1000);
}

export function sessionTokenSecret(): string {
  const secret = Deno.env.get("SESSION_TOKEN_SECRET") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) {
    throw new Error(
      "Missing SESSION_TOKEN_SECRET (and SUPABASE_SERVICE_ROLE_KEY)",
    );
  }
  return secret;
}
