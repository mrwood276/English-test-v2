import { tooManyRequests } from "./errors.ts";

/** The part of the database client this module needs, so it can be tested without a database. */
export interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * Counts one attempt for `key` in `bucket` and throws 429 when the limit for the current window is exceeded.
 * Example: rateLimit(db, "join", `${ip}`, { limit: 20, windowSeconds: 60 }).
 */
export async function rateLimit(
  db: RpcClient,
  bucket: string,
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<void> {
  const { data, error } = await db.rpc("rate_limit_hit", {
    p_bucket: bucket,
    p_key: key.slice(0, 200),
    p_window_seconds: opts.windowSeconds,
  });
  if (error) throw new Error(`rate limit check failed: ${error.message}`);
  const hits = Number(data);
  if (hits > opts.limit) throw tooManyRequests(opts.windowSeconds);
}

/** Best effort caller address, used only as a rate limit key. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}
