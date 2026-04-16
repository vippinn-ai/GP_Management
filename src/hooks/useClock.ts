import { useEffect, useState } from "react";

/**
 * Returns the current time as an ISO string, updated on the given interval.
 * Extracted from App.tsx to keep the clock state isolated and make it easy
 * to scope re-renders to only the components that actually need the time.
 */
export function useClock(intervalMs = 1000): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date().toISOString()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
