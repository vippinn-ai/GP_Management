import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, jsonResponse, requireAdmin } from "../_shared/admin.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const guard = await requireAdmin(request);
  if ("error" in guard) {
    return guard.error;
  }

  try {
    const { name, username, role, password } = await request.json();
    if (!name?.trim() || !username?.trim() || !role || !password) {
      return jsonResponse({ error: "Missing required user fields." }, 400);
    }

    const adminClient = createAdminClient();
    const hiddenEmail = `${crypto.randomUUID()}@users.breakperfect.local`;

    const { data: authUser, error: authError } = await adminClient.auth.admin.createUser({
      email: hiddenEmail,
      password,
      email_confirm: true
    });

    if (authError || !authUser.user) {
      return jsonResponse({ error: authError?.message ?? "Unable to create auth user." }, 400);
    }

    const { error: profileError } = await adminClient.from("profiles").insert({
      id: authUser.user.id,
      name: name.trim(),
      username: username.trim(),
      auth_email: hiddenEmail,
      role,
      active: true
    });

    if (profileError) {
      await adminClient.auth.admin.deleteUser(authUser.user.id);
      return jsonResponse({ error: profileError.message }, 400);
    }

    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ error: "Unable to create user." }, 500);
  }
});
