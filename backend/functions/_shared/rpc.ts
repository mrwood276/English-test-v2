import { badRequest } from "./errors.ts";

/** The part of the database client this module needs, so it can be tested without a database. */
export interface RpcDb {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string; hint?: string | null; code?: string | null } | null;
  }>;
}

/**
 * Calls a database function. Problems the person can fix (raised with hint "validation") become a friendly 400;
 * anything else is an unexpected error that the wrapper logs and hides.
 */
export async function callRpc<T = unknown>(db: RpcDb, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) {
    if (error.hint === "validation") throw badRequest(error.message);
    if (error.code === "22P02" || error.code === "22023") throw badRequest("Some of the values are not valid.");
    throw new Error(`rpc ${name} failed: ${error.message}`);
  }
  return data as T;
}
