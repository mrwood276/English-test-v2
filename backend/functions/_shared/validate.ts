import { badRequest } from "./errors.ts";

/** Small input checks. Every function throws a friendly 400 that names the field. */

export function asObject(v: unknown, path = "body"): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest(`${path} must be an object.`);
  return v as Record<string, unknown>;
}

export function asString(v: unknown, path: string, opts: { min?: number; max: number; trim?: boolean }): string {
  if (typeof v !== "string") throw badRequest(`${path} must be text.`);
  const s = opts.trim === false ? v : v.trim();
  const min = opts.min ?? 0;
  if (s.length < min) throw badRequest(min === 1 ? `${path} is required.` : `${path} must be at least ${min} characters.`);
  if (s.length > opts.max) throw badRequest(`${path} must be at most ${opts.max} characters.`);
  // Control characters (except tab and newline) have no place in names or answers.
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)) throw badRequest(`${path} contains characters that are not allowed.`);
  return s;
}

export function asInt(v: unknown, path: string, opts: { min: number; max: number }): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw badRequest(`${path} must be a whole number.`);
  if (v < opts.min || v > opts.max) throw badRequest(`${path} must be between ${opts.min} and ${opts.max}.`);
  return v;
}

export function asBool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw badRequest(`${path} must be true or false.`);
  return v;
}

export function asEnum<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw badRequest(`${path} must be one of: ${allowed.join(", ")}.`);
  }
  return v as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function asUuid(v: unknown, path: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw badRequest(`${path} is not a valid id.`);
  return v.toLowerCase();
}

export function asArray(v: unknown, path: string, opts: { max: number; min?: number }): unknown[] {
  if (!Array.isArray(v)) throw badRequest(`${path} must be a list.`);
  if (v.length > opts.max) throw badRequest(`${path} can have at most ${opts.max} items.`);
  if (v.length < (opts.min ?? 0)) throw badRequest(`${path} needs at least ${opts.min} items.`);
  return v;
}

export function asNumber(v: unknown, path: string, opts: { min: number; max: number }): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw badRequest(`${path} must be a number.`);
  if (v < opts.min || v > opts.max) throw badRequest(`${path} must be between ${opts.min} and ${opts.max}.`);
  return v;
}

// Deliberately simple: the sign-in service is the real authority on what an address is, and a person can
// fix "that does not look like an email address" without guessing.
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

/** An email address, lowercased so two accounts can never differ only by case. */
export function asEmail(v: unknown, path: string): string {
  const s = asString(v, path, { min: 5, max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw badRequest(`${path} does not look like an email address.`);
  return s;
}

/** Text that is never shown as HTML (names, labels, topics): angle brackets are not allowed. */
export function asPlain(v: unknown, path: string, opts: { min?: number; max: number }): string {
  const s = asString(v, path, opts);
  if (/[<>]/.test(s)) throw badRequest(`${path} cannot contain < or >.`);
  return s;
}

/** Applies `fn` only when the value is present (not undefined or null). */
export function optional<T>(v: unknown, fn: (value: unknown) => T): T | undefined {
  return v === undefined || v === null ? undefined : fn(v);
}
