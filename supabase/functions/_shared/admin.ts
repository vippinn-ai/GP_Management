import { createClient } from "npm:@supabase/supabase-js@2";
import { getCorsHeaders } from "./cors.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export function createAdminClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Supabase edge function is missing service-role configuration.");
  }
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export function createUserClient(authHeader: string) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase edge function is missing anon-key configuration.");
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export function jsonResponse(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(origin),
      "Content-Type": "application/json"
    }
  });
}

export async function requireAdmin(request: Request) {
  const origin = request.headers.get("Origin");
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return { error: jsonResponse({ error: "Unauthorized" }, 401, origin) };
  }

  let userClient;
  let adminClient;
  try {
    userClient = createUserClient(authHeader);
    adminClient = createAdminClient();
  } catch (error) {
    return {
      error: jsonResponse(
        { error: error instanceof Error ? error.message : "Supabase function configuration is incomplete." },
        500,
        origin
      )
    };
  }

  const { data: { user }, error: userError } = await userClient.auth.getUser();

  if (userError || !user) {
    return { error: jsonResponse({ error: "Unauthorized" }, 401, origin) };
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role, active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile || profile.role !== "admin" || !profile.active) {
    return { error: jsonResponse({ error: "Admin access required" }, 403, origin) };
  }

  return { adminClient, actorId: user.id, origin };
}
