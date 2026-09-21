import { createHandler } from "./handler.ts";
import { serviceClient } from "../_shared/db.ts";

Deno.serve(createHandler(() => serviceClient() as never));
