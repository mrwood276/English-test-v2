import { handle } from "../_shared/http.ts";
import { methodNotAllowed } from "../_shared/errors.ts";
import { requireStaff } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";

/** GET: who is signed in? Used by the teacher/admin app right after login to decide what to show. */
Deno.serve(handle(async (req) => {
  if (req.method !== "GET") throw methodNotAllowed();
  const me = await requireStaff(req, serviceClient());
  return { user: { id: me.userId, fullName: me.fullName, role: me.role } };
}));
