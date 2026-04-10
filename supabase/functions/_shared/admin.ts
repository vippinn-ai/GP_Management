import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "./cors.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export function createAdminClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export function createUserClient(authHeader: string) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader
      }
    },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

export async function requireAdmin(request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return { error: jsonResponse({ error: "Unauthorized" }, 401) };
  }

  const userClient = createUserClient(authHeader);
  const {
    data: { user },
    error: userError
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return { error: jsonResponse({ error: "Unauthorized" }, 401) };
  }

  const adminClient = createAdminClient();
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role, active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile || profile.role !== "admin" || !profile.active) {
    return { error: jsonResponse({ error: "Admin access required" }, 403) };
  }

  return { adminClient, actorId: user.id };
}
