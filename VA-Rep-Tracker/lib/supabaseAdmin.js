// Server-side Supabase admin client
// Keeps the service-role credential inside server-only modules and lazily
// reuses a single client instance for refresh requests in this process.
import { createClient } from "@supabase/supabase-js";
import process from "node:process";

let supabaseAdminClient;

// Returns the cached privileged client, creating it from server environment
// variables on first use. Throws a clear configuration error if either value
// is missing; this module must not be imported by browser code.
export function getSupabaseAdmin() {
  if (supabaseAdminClient) {
    return supabaseAdminClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  supabaseAdminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  return supabaseAdminClient;
}
