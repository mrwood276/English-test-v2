/** Letters and digits that are hard to mix up when written on a board (no 0/O, 1/I). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 characters, so one random byte maps evenly

/** Makes an exam code such as "K7M2QX". */
export function generateAccessCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b & 31];
  return code;
}

/** Codes are typed by students, so accept lower case and stray spaces. */
export function normalizeAccessCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export const ACCESS_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
