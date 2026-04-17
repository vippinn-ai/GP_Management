import { getCorsHeaders } from "../_shared/cors.ts";
import { createAdminClient, jsonResponse } from "../_shared/admin.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(origin) });
  }

  // Rate limit: 10 attempts per minute per IP.
  const clientIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  if (!checkRateLimit(`login:${clientIp}`, 10, 60_000)) {
    return jsonResponse({ error: "Too many attempts. Please wait before trying again." }, 429, origin);
  }

  try {
    const { username } = await request.json();
    if (!username?.trim()) {
      return jsonResponse({ error: "Username is required." }, 400, origin);
    }

    if (username.trim().length > 64) {
      return jsonResponse({ error: "Invalid username or password." }, 401, origin);
    }

    const adminClient = createAdminClient();
    const { data: profile, error } = await adminClient
      .from("profiles")
      .select("auth_email, active")
      .ilike("username", username.trim())
      .maybeSingle();

    if (error || !profile || !profile.active) {
      return jsonResponse({ error: "Invalid username or password." }, 401, origin);
    }

    return jsonResponse({ email: profile.auth_email }, 200, origin);
  } catch {
    return jsonResponse({ error: "Unable to resolve username." }, 500, origin);
  }
});
