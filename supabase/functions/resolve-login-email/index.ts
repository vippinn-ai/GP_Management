import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, jsonResponse } from "../_shared/admin.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { username } = await request.json();
    if (!username?.trim()) {
      return jsonResponse({ error: "Username is required." }, 400);
    }

    const adminClient = createAdminClient();
    const { data: profile, error } = await adminClient
      .from("profiles")
      .select("auth_email, active")
      .ilike("username", username.trim())
      .maybeSingle();

    if (error || !profile || !profile.active) {
      return jsonResponse({ error: "Invalid username or password." }, 401);
    }

    return jsonResponse({ email: profile.auth_email });
  } catch {
    return jsonResponse({ error: "Unable to resolve username." }, 500);
  }
});
