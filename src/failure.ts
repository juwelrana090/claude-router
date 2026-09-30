/**
 * Turns an upstream failure (HTTP status + body, or a network error) into a decision:
 * how long to rest the key, whether a quick retry on the same key is worth it, and a short,
 * secret-free reason that the UI can show. Retry-After wins when the provider sends one.
 */
export interface Failure {
  kind: "persistent" | "transient";
  /** A quick retry on the same key may succeed (rate limit, overload, network blip). */
  retryable: boolean;
  /** How long to wait before that retry. */
  waitMs: number;
  /** How long to rest the key if it still fails. */
  cooldownMs: number;
  /** "HTTP 429: code 1113: Insufficient balance ..." */
  reason: string;
  snippet: string;
}

const MINUTE = 60_000;
const RATE_LIKE = /rate.?limit|too many requests|concurren|overload|try again|temporar|busy|throttl/i;
const QUOTA_LIKE =
  /balance|insufficient|quota|exhaust|resource package|recharge|top.?up|billing|credit|subscription|usage limit|limit (has been )?reached|has been reached|exceeded|not allowed|not permitted|permission|expired|invalid.{0,20}key|unauthori|forbidden|suspend|disabled|not include|does not include/i;

function redact(s: string): string {
  return s
    .replace(/\b(sk|or|zai|gsk|key)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/[A-Za-z0-9_-]{28,}/g, "[redacted]");
}

export function snippetOf(bodyText: string): string {
  let msg = "";
  let code = "";
  try {
    const j = JSON.parse(bodyText);
    msg = String(j?.error?.message ?? j?.message ?? j?.msg ?? (typeof j?.error === "string" ? j.error : "") ?? "");
    const c = j?.error?.code ?? j?.code ?? "";
    code = c === "" || c == null ? "" : String(c);
  } catch {
    msg = bodyText.replace(/<[^>]+>/g, " ");
  }
  const one = redact(`${code ? `code ${code}: ` : ""}${msg}`).replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 157)}...` : one;
}

/** `streak` = how many times in a row this key has already failed. */
export function classifyFailure(status: number, retryAfterHeader: string | null, bodyText: string, streak: number): Failure {
  const snippet = snippetOf(bodyText);
  const reason = `HTTP ${status || "network"}${snippet ? `: ${snippet}` : ""}`;
  const ra = Number(retryAfterHeader);
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60 * MINUTE) : 0;
  const base = Number(process.env.ROUTER_RETRY_BASE_MS ?? 1000); // tests shorten this

  const hay = `${snippet} ${bodyText.slice(0, 400)}`;
  const persistent =
    status === 401 || status === 402 || status === 403 ||
    (status === 429 && !RATE_LIKE.test(hay) && QUOTA_LIKE.test(hay));
  if (persistent) {
    return { kind: "persistent", retryable: false, waitMs: 0, cooldownMs: Math.max(retryAfterMs, 10 * MINUTE), reason, snippet };
  }
  // Transient: rate limit, overload, 5xx, network. Rest grows on repeated failures (8s, 16s, 32s ... 5 min).
  const grow = Math.min(8_000 * 2 ** Math.max(0, streak), 5 * MINUTE);
  const cool = status >= 500 || status === 0 ? Math.min(15_000 * 2 ** Math.max(0, streak), 2 * MINUTE) : Math.max(retryAfterMs, grow);
  return {
    kind: "transient",
    retryable: status !== 501 && status !== 505,
    waitMs: retryAfterMs > 0 ? retryAfterMs : base,
    cooldownMs: cool,
    reason,
    snippet,
  };
}