/**
 * HTTP + SSE client for the claude-router admin API.
 *
 * Auth contract: every request carries header `x-api-key: <ROUTER_KEY>`.
 * The key is asked for once and kept in sessionStorage. EventSource cannot set
 * headers, so the SSE stream passes `?key=<ROUTER_KEY>` instead; a 401 triggers
 * a re-prompt via the unauthorized handler.
 */
import type {
  EtaEvent,
  EtaSnapshot,
  Snapshot,
  UsageRange,
  UsageSummary,
} from './types';

export const ROUTER_KEY_STORAGE_KEY = 'claude-router-key';

// ---------- Key gate ----------

// Fallback for when sessionStorage is unavailable, so the key is still asked for only once.
let memoryKey: string | null = null;

export function getRouterKey(): string | null {
  try {
    return sessionStorage.getItem(ROUTER_KEY_STORAGE_KEY) ?? memoryKey;
  } catch {
    return memoryKey;
  }
}

export function setRouterKey(key: string): void {
  memoryKey = key;
  try {
    sessionStorage.setItem(ROUTER_KEY_STORAGE_KEY, key);
  } catch {
    // sessionStorage unavailable (e.g. hardened privacy mode); memoryKey covers this tab.
  }
}

export function clearRouterKey(): void {
  memoryKey = null;
  try {
    sessionStorage.removeItem(ROUTER_KEY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Returns the key to use, or null to abort the current call. */
export type UnauthorizedHandler = () => string | null | Promise<string | null>;

let unauthorizedHandler: UnauthorizedHandler = () =>
  window.prompt('ROUTER_KEY required for the admin API:');

/**
 * Install a nicer key-prompt UI (e.g. a modal). The handler must resolve with the
 * entered key, or null if the user cancelled.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

let pendingAsk: Promise<string | null> | null = null;
let declinedUntil = 0;
const DECLINE_COOLDOWN_MS = 60_000;

/**
 * `usedKey` is the key the failing request was sent with. Requests that were already in
 * flight when the user typed the key come back 401 afterwards; they must reuse the new key
 * instead of asking again (and must never wipe it). After a cancel, stay quiet for a minute
 * so the background pollers don't reopen the dialog every few seconds.
 */
async function askForKey(usedKey: string | null): Promise<string | null> {
  const current = getRouterKey();
  if (current && current !== usedKey) return current;
  if (pendingAsk) return pendingAsk;
  if (Date.now() < declinedUntil) return null;
  pendingAsk = (async () => {
    try {
      const next = await unauthorizedHandler();
      if (next) {
        setRouterKey(next);
        declinedUntil = 0;
      } else {
        declinedUntil = Date.now() + DECLINE_COOLDOWN_MS;
      }
      return next;
    } finally {
      pendingAsk = null;
    }
  })();
  return pendingAsk;
}

// ---------- Fetch helper ----------

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Fetch JSON from the admin API with the x-api-key header attached.
 * On 401 a key that was stored while the request was in flight is retried first;
 * otherwise the unauthorized handler runs once and the request retries with it.
 */
export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const key = getRouterKey();
  if (key) headers.set('x-api-key', key);

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    if (retry && (await askForKey(key))) return api<T>(path, init, false);
    throw new ApiError(401, `Unauthorized: ${init.method ?? 'GET'} ${path}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      const fieldMsgs = Array.isArray(data?.errors)
        ? data.errors
            .map((e: { field: string; message: string }) => `${e.field}: ${e.message}`)
            .join('; ')
        : '';
      detail = fieldMsgs || data?.error?.message || detail;
    } catch {
      // body wasn't JSON (e.g. a raw 404 from a proxy) — keep the generic status line
    }
    throw new ApiError(res.status, `${init.method ?? 'GET'} ${path} failed: ${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- Contract endpoints ----------

export function fetchSnapshot(): Promise<Snapshot> {
  return api<Snapshot>('/admin/snapshot');
}

export function fetchEtaSnapshot(): Promise<EtaSnapshot> {
  return api<EtaSnapshot>('/admin/eta');
}

export function fetchUsageSummary(range: UsageRange): Promise<UsageSummary> {
  return api<UsageSummary>(`/admin/usage/summary?range=${encodeURIComponent(range)}`);
}

// ---------- Live SSE (/admin/events) ----------

export type EtaEventHandler = (event: EtaEvent) => void;

/**
 * Subscribe to the "eta" SSE stream with auto-reconnect (exponential backoff,
 * capped at 15s). A fatal connection failure (which is also what a 401 on the
 * header-less EventSource looks like) never opens the key prompt itself: the polled
 * api() calls do that. It waits for a key, then reconnects with `?key=`.
 *
 * Returns an unsubscribe function.
 */
export function subscribeEta(handler: EtaEventHandler): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: number | undefined;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    const key = getRouterKey();
    if (!key) {
      reconnectTimer = window.setTimeout(connect, 2000);
      return;
    }
    source = new EventSource(`/admin/events?key=${encodeURIComponent(key)}`);

    source.addEventListener('eta', (ev: Event) => {
      attempt = 0;
      try {
        handler(JSON.parse((ev as MessageEvent).data) as EtaEvent);
      } catch {
        // Malformed event payload; skip it.
      }
    });

    source.onerror = () => {
      if (stopped) return;
      // Whether EventSource gave up or is retrying on its own, close it and reconnect with
      // backoff. Auth problems are handled by the api() pollers, not here.
      source?.close();
      attempt += 1;
      reconnectTimer = window.setTimeout(
        connect,
        Math.min(1000 * 2 ** attempt, 15000),
      );
    };
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    source?.close();
  };
}
