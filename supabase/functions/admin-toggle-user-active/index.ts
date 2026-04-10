import { corsHeaders } from "../_shared/cors.ts";
import { jsonResponse, requireAdmin } from "../_shared/admin.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const guard = await requireAdmin(request);
  if ("error" in guard) {
    return guard.error;
  }

  try {
    const { userId } = await request.json();
    if (!userId) {
      return jsonResponse({ error: "Missing user id." }, 400);
    }

    const { adminClient } = guard;
    const { data: profile } = await adminClient
      .from("profiles")
      .select("id, role, active")
      .eq("id", userId)
      .maybeSingle();

    if (!profile) {
      return jsonResponse({ error: "User not found." }, 404);
    }

    if (profile.active && profile.role === "admin") {
      const { count } = await adminClient
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "admin")
        .eq("active", true);

      if ((count ?? 0) <= 1) {
        return jsonResponse({ error: "At least one active admin must remain." }, 400);
      }
    }

    const { error } = await adminClient
      .from("profiles")
      .update({ active: !profile.active })
      .eq("id", userId);

    if (error) {
      return jsonResponse({ error: error.message }, 400);
    }

    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ error: "Unable to update user access." }, 500);
  }
});
