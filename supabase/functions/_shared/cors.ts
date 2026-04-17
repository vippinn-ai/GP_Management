// ALLOWED_ORIGIN env secret supports comma-separated origins, e.g.:
//   https://your-app.workers.dev,http://localhost:4173
// Falls back to "*" in local dev (when the secret is not set).
const raw = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const ALLOWED_ORIGINS = raw.split(",").map((s) => s.trim()).filter(Boolean);

export function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  let allowOrigin: string;
  if (ALLOWED_ORIGINS.includes("*")) {
    allowOrigin = "*";
  } else if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    allowOrigin = requestOrigin;
  } else {
    // Origin not in the allowed list — return the first configured origin.
    // The browser will reject the response anyway; this avoids leaking "*".
    allowOrigin = ALLOWED_ORIGINS[0] ?? "*";
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
  };
}
