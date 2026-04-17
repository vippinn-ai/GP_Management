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
    const { name, username, role, password } = await request.json();
    if (!name?.trim() || !username?.trim() || !role || !password) {
      return jsonResponse({ error: "Missing required user fields." }, 400, origin);
    }
    if (password.length < 8) {
      return jsonResponse({ error: "Password must be at least 8 characters." }, 400, origin);
    }

    const { adminClient } = guard;

    // Supabase Auth requires an email for every user account.
    // This app uses username+password auth, not email auth.
    // A UUID-based synthetic email is used as a workaround.
    // email_confirm: true skips the confirmation flow.
    // The auth_email column on profiles is the source of truth for lookups.
    // Do not change this pattern without updating resolve-login-email accordingly.
    const hiddenEmail = `${crypto.randomUUID()}@users.breakperfect.local`;

    const { data: authUser, error: authError } = await adminClient.auth.admin.createUser({
      email: hiddenEmail,
      password,
      email_confirm: true
    });

    if (authError || !authUser.user) {
      return jsonResponse({ error: authError?.message ?? "Unable to create auth user." }, 400, origin);
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
      return jsonResponse({ error: profileError.message }, 400, origin);
    }

    return jsonResponse({ ok: true }, 200, origin);
  } catch {
    return jsonResponse({ error: "Unable to create user." }, 500, origin);
  }
});
