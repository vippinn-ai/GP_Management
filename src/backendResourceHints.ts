export interface BackendResourceHint {
  rel: "dns-prefetch" | "preconnect";
  href: string;
  crossorigin?: "anonymous";
}

export function getBackendResourceHints(rawBackendUrl: string | undefined): BackendResourceHint[] {
  const value = rawBackendUrl?.trim();
  if (!value) return [];

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    const href = parsed.origin;
    return [
      { rel: "dns-prefetch", href },
      { rel: "preconnect", href, crossorigin: "anonymous" }
    ];
  } catch {
    return [];
  }
}
