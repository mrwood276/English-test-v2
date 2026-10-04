/**
 * Shared error handling for teacher screens.
 * All screens use the same pattern: show a friendly message from the error,
 * and ignore SessionExpiredError (the core API already redirected to sign-in).
 */
import { SessionExpiredError } from "../core/auth.js";

/**
 * Returns a human-readable message from an error.
 * Falls back to a generic message if the error has no message.
 */
export function errorText(err) {
  return err?.message || "Something went wrong. Please try again.";
}

/**
 * Returns true if the error is a SessionExpiredError.
 * The core API already redirects to sign-in, so the screen doesn't need to show anything.
 */
export function ignorable(err) {
  return err instanceof SessionExpiredError;
}