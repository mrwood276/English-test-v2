import { ApiError, badRequest, payloadTooLarge } from "./errors.ts";

/** Set ALLOWED_ORIGIN (a function secret) to the app's address to restrict browsers; "*" until the address is known. */
function allowedOrigin(): string {
  return Deno.env.get("ALLOWED_ORIGIN") ?? "*";
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(), ...extra },
  });
}

export interface RequestContext {
  requestId: string;
}

type Handler = (req: Request, ctx: RequestContext) => Promise<Response | unknown> | Response | unknown;

/**
 * Wraps a handler with CORS, JSON output, and error handling:
 * - ApiError: returned as { error, code, details? } with its own status.
 * - Anything else: logged with a request id, and the person only sees a generic message.
 */
export function handle(handler: Handler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const requestId = crypto.randomUUID();
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      const result = await handler(req, { requestId });
      if (result instanceof Response) return result;
      return json(200, result ?? {}, { "X-Request-Id": requestId });
    } catch (err) {
      if (err instanceof ApiError) {
        const headers: Record<string, string> = { "X-Request-Id": requestId };
        const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (err.status === 429 && typeof retry === "number") headers["Retry-After"] = String(retry);
        return json(err.status, { error: err.message, code: err.code, details: err.details }, headers);
      }
      console.error(JSON.stringify({ requestId, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }));
      return json(500, { error: "Something went wrong. Please try again.", code: "internal_error", requestId }, { "X-Request-Id": requestId });
    }
  };
}

/** Reads a JSON body with a size limit. */
export async function readJson(req: Request, maxBytes = 100_000): Promise<unknown> {
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
