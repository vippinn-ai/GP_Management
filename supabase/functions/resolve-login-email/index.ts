import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, jsonResponse } from "../_shared/admin.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Rate limit: 10 attempts per minute per IP.
  // cf-connecting-ip is set by Cloudflare on all requests passing through their network.
  const clientIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  if (!checkRateLimit(`login:${clientIp}`, 10, 60_000)) {
    return jsonResponse({ error: "Too many attempts. Please wait before trying again." }, 429);
  }

  try {
    const { username } = await request.json();
    if (!username?.trim()) {
      return jsonResponse({ error: "Username is required." }, 400);
    }

    // Return 401 (not 400) to avoid leaking that the input was too long vs. not found.
    if (username.trim().length > 64) {
      return jsonResponse({ error: "Invalid username or password." }, 401);
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
