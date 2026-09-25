/**
 * Where to send someone after they sign in or sign up.
 *
 * A `callbackUrl` arrives in the query string, which means it arrives from
 * whoever wrote the link. One that accepted `https://elsewhere.example` would
 * turn every sign-in link into an open redirect — the classic way a phishing
 * page borrows a real domain's credibility, and worse here because the link
 * that most needs to carry a callback is an invitation somebody was sent.
 *
 * So only a path within this application survives: it must start with a single
 * slash. `//elsewhere.example` is rejected too, because a protocol-relative URL
 * is an absolute one wearing a relative one's clothes.
 *
 * Shared by the sign-in page and both auth actions, so the rule that decides
 * where a link points and the rule that decides where a redirect goes cannot
 * drift apart.
 */
export const DEFAULT_CALLBACK = "/dashboard";

export function safeCallbackUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return DEFAULT_CALLBACK;
  return raw;
}

/** Appends a callback to a path, omitting it when it is the default anyway. */
export function withCallback(path: string, callbackUrl: string): string {
  if (callbackUrl === DEFAULT_CALLBACK) return path;
  return `${path}?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}
