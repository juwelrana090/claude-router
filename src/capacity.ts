import type { ModelCfg, ProviderCfg } from "./config";
import { applyGuard, estimateTokens, readConfig } from "./contextGuard";
import { providerToday } from "./history";

const fmt = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

/**
 * Proactive failover: if a provider has a daily request or token limit and today's usage already
 * reached it, say so (the router then skips that route instead of waiting for the provider to refuse).
 */
export function budgetReason(name: string, p: ProviderCfg): string | null {
  if (!p.dailyRequests && !p.dailyTokens) return null;
  const t = providerToday(name);
  if (p.dailyRequests && t.requests >= p.dailyRequests) {
    return `daily request limit reached (${t.requests} of ${p.dailyRequests} today)`;
  }
  if (p.dailyTokens && t.tokens >= p.dailyTokens) {
    return `daily token budget reached (${fmt(t.tokens)} of ${fmt(p.dailyTokens)} today)`;
  }
  return null;
}

export interface Fit {
  body: Record<string, unknown>;
  /** Tokens removed from the prompt so it fits this route's window. */
  saved: number;
  /** Set when the prompt cannot fit even after clearing: the route must be skipped. */
  skip?: string;
  note?: string;
}

/**
 * Multi-provider safety net: a fallback model often has a smaller context window than the model you
 * picked. When a route declares `contextWindow`, an oversized prompt is first shrunk by clearing old tool
 * output (remembered per session AND per route, so that route sees identical text on every request and its
 * cache keeps working; the main route is untouched). If it still does not fit, the route is skipped with a
 * reason instead of sending a request that the provider would reject.
 */
export function fitToWindow(body: Record<string, unknown>, m: ModelCfg, sessionId: string, route: string): Fit {
  if (!m.contextWindow) return { body, saved: 0 };
  const limit = Math.floor(m.contextWindow * 0.9); // the token estimate is rough: keep 10% headroom
  const est = estimateTokens(body);
  if (est <= limit) return { body, saved: 0 };
  const base = readConfig();
  const g = applyGuard(body, `${sessionId}|fit|${route}`, {
    ...base, mode: "on", highTokens: limit, lowTokens: Math.floor(m.contextWindow * 0.6),
  });
  if (g.result.afterTokens > limit || g.body === body) {
    return { body, saved: 0, skip: `prompt ~${fmt(est)} tokens does not fit the ${fmt(m.contextWindow)} window, even after clearing old tool output` };
  }
  return { body: g.body as Record<string, unknown>, saved: g.result.saved, note: `trimmed ~${fmt(g.result.saved)} tokens to fit the ${fmt(m.contextWindow)} window` };
}