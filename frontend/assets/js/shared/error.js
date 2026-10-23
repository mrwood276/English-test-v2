import { SessionExpiredError } from "../core/auth.js";

export function errorText(err) {
  return err?.message || "Something went wrong. Please try again.";
}

export function ignorable(err) {
  return err instanceof SessionExpiredError;
}
