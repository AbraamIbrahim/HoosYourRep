// Creates and caches the privileged Supabase client for server-side jobs only.
import { createClient } from "@supabase/supabase-js";
import process from "node:process";

let supabaseAdminClient;

// Returns the server client, failing clearly when its private credentials are absent.
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
