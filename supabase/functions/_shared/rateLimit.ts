// In-process sliding window rate limiter.
//
// IMPORTANT: Supabase Edge Functions may run multiple isolates in parallel.
// This store is per-isolate, not globally coordinated. It is effective against
// naive brute-force attacks from a single client but not against distributed
// attacks. On the free tier (no Redis), this is the best available option.
// State resets on cold starts.

interface Entry {
  count: number;
  windowStart: number;
}

const store = new Map<string, Entry>();
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function maybeCleanup(windowMs: number) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (now - entry.windowStart > windowMs * 2) {
      store.delete(key);
    }
  }
}

/**
 * Returns true if the request is allowed, false if it should be rate-limited.
 * @param key      Unique key (e.g. "login:1.2.3.4")
 * @param maxRequests  Max allowed requests within the window
 * @param windowMs     Window duration in milliseconds
 */
export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  maybeCleanup(windowMs);
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= maxRequests) {
    return false;
  }
  entry.count++;
  return true;
}
