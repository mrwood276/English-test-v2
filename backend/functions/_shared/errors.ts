/** An error whose message is safe to show to the person using the app. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, "bad_request", message, details);
export const unauthorized = (message = "Please sign in.") => new ApiError(401, "unauthorized", message);
export const forbidden = (message = "You do not have access to this.") => new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found.") => new ApiError(404, "not_found", message);
export const methodNotAllowed = () => new ApiError(405, "method_not_allowed", "This action is not allowed here.");
export const conflict = (message: string) => new ApiError(409, "conflict", message);
export const payloadTooLarge = () => new ApiError(413, "payload_too_large", "That request is too large.");
export const tooManyRequests = (retryAfterSeconds: number) =>
  new ApiError(429, "too_many_requests", "Too many attempts. Please wait a moment and try again.", { retryAfterSeconds });
