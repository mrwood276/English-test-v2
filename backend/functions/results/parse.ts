import { asInt, asNumber, asString } from "../_shared/validate.ts";

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** The screen talks in minutes; the database stores seconds. The window matches the SQL guard. */
export function asSeconds(v: unknown, path: string): number {
  return asInt(v, path, { min: 1, max: 120 }) * 60;
}

/** A grade from the teacher: never negative, at most two decimals; the maximum is checked by SQL. */
export function asPoints(v: unknown, path: string): number {
  const n = asNumber(v, path, { min: 0, max: 1000 });
  return Math.round(n * 100) / 100;
}

/** The optional comment on a grade. Empty means "no comment", not an empty string in the database. */
export function asFeedback(v: unknown): string | null {
  if (isBlank(v)) return null;
  return asString(v, "Comment", { max: 2000 });
}
