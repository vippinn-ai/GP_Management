// During local dev (supabase functions serve), ALLOWED_ORIGIN is unset and falls back to "*".
// In production, set the ALLOWED_ORIGIN secret in the Supabase dashboard to your Cloudflare Pages URL.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

export const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
