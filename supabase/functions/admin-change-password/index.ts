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
    const { userId, password } = await request.json();
    if (!userId || !password) {
      return jsonResponse({ error: "Missing password update payload." }, 400);
    }

    const { adminClient } = guard;
    const { error } = await adminClient.auth.admin.updateUserById(userId, {
      password
    });

    if (error) {
      return jsonResponse({ error: error.message }, 400);
    }

    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ error: "Unable to change password." }, 500);
  }
});
