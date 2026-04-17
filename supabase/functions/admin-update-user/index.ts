import { getCorsHeaders } from "../_shared/cors.ts";
import { jsonResponse, requireAdmin } from "../_shared/admin.ts";

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(origin) });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 4096) {
    return jsonResponse({ error: "Request too large." }, 413, origin);
  }

  const guard = await requireAdmin(request);
  if ("error" in guard) return guard.error;

  try {
    const { id, name, username, role } = await request.json();
    if (!id || !name?.trim() || !username?.trim() || !role) {
      return jsonResponse({ error: "Missing required user fields." }, 400, origin);
    }

    const { adminClient } = guard;
    const { data: currentProfile } = await adminClient
      .from("profiles")
      .select("id, role, active")
      .eq("id", id)
      .maybeSingle();

    if (!currentProfile) {
      return jsonResponse({ error: "User not found." }, 404, origin);
    }

    if (currentProfile.active && currentProfile.role === "admin" && role !== "admin") {
      const { count } = await adminClient
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "admin")
        .eq("active", true);

      if ((count ?? 0) <= 1) {
        return jsonResponse({ error: "At least one active admin must remain." }, 400, origin);
      }
    }

    const { error } = await adminClient
      .from("profiles")
      .update({ name: name.trim(), username: username.trim(), role })
      .eq("id", id);

    if (error) {
      return jsonResponse({ error: error.message }, 400, origin);
    }

    return jsonResponse({ ok: true }, 200, origin);
  } catch {
    return jsonResponse({ error: "Unable to update user." }, 500, origin);
  }
});
