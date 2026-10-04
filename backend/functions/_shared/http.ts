import { ApiError, badRequest, payloadTooLarge } from "./errors.ts";

/**
 * The app's address, from the ALLOWED_ORIGIN function secret: one origin, or several separated by
 * commas (so the real address and a local test one can both work). Unset, empty, or "*" allows any
 * website to call the functions, which is fine while the app has no address but not for production.
 */
function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGIN") ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * What to answer with. With no list (or "*") any site may read the answer. With a list, only a caller
 * whose own Origin header is on that list is echoed back: an off-list website gets a name that is not
 * its own, so its browser refuses to hand over the answer. A caller with no Origin header at all (curl,
 * a scheduled job) is not a browser and gets the first entry, which it simply ignores.
 * The tokens this API uses travel in the Authorization header, not in cookies, so no
 * Access-Control-Allow-Credentials is needed — and the wildcard stays usable because of that.
 */
function allowOrigin(req?: Request): string {
  const list = allowedOrigins();
  if (list.length === 0 || list.includes("*")) return "*";
  const origin = req?.headers.get("origin");
  if (!origin) return list[0];
  return list.includes(origin) ? origin : list[0];
}

export function corsHeaders(req?: Request): Record<string, string> {
  const allow = allowOrigin(req);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
  // A per-caller answer must never be cached and then handed to a different caller.
  if (allow !== "*") headers["Vary"] = "Origin";
  return headers;
}

export function json(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
  req?: Request,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req),
      ...extra,
    },
  });
}

export interface RequestContext {
  requestId: string;
}

type Handler = (
  req: Request,
  ctx: RequestContext,
) => Promise<Response | unknown> | Response | unknown;

/**
 * Wraps a handler with CORS, JSON output, and error handling:
 * - ApiError: returned as { error, code, details? } with its own status.
 * - Anything else: logged with a request id, and the person only sees a generic message.
 */
export function handle(handler: Handler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const requestId = crypto.randomUUID();
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    try {
      const result = await handler(req, { requestId });
      if (result instanceof Response) return result;
      return json(200, result ?? {}, { "X-Request-Id": requestId }, req);
    } catch (err) {
      if (err instanceof ApiError) {
        const headers: Record<string, string> = { "X-Request-Id": requestId };
        const retry =
          (err.details as { retryAfterSeconds?: number } | undefined)
            ?.retryAfterSeconds;
        if (err.status === 429 && typeof retry === "number") {
          headers["Retry-After"] = String(retry);
        }
        return json(
          err.status,
          { error: err.message, code: err.code, details: err.details },
          headers,
          req,
        );
      }
      console.error(
        JSON.stringify({
          requestId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
      );
      return json(
        500,
        {
          error: "Something went wrong. Please try again.",
          code: "internal_error",
          requestId,
        },
        { "X-Request-Id": requestId },
        req,
      );
    }
  };
}

/** Reads a JSON body with a size limit. */
export async function readJson(
  req: Request,
  maxBytes = 100_000,
): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw payloadTooLarge();
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw payloadTooLarge();
  if (text.trim() === "") throw badRequest("The request has no content.");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("The request is not valid JSON.");
  }
}
