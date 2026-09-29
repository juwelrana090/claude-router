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

export function getRouterKey(): string | null {
  try {
    return sessionStorage.getItem(ROUTER_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setRouterKey(key: string): void {
  try {
    sessionStorage.setItem(ROUTER_KEY_STORAGE_KEY, key);
  } catch {
    // sessionStorage unavailable (e.g. hardened privacy mode); key stays per-call.
  }
}

export function clearRouterKey(): void {
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

async function askForKey(): Promise<string | null> {
  clearRouterKey();
  const next = await unauthorizedHandler();
  if (next) setRouterKey(next);
  return next;
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
 * On 401 the stored key is dropped, the unauthorized handler runs once and the
 * request is retried with the fresh key.
 */
export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const key = getRouterKey();
  if (key) headers.set('x-api-key', key);

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    if (retry && (await askForKey())) return api<T>(path, init, false);
    throw new ApiError(401, `Unauthorized: ${init.method ?? 'GET'} ${path}`);
  }
  if (!res.ok) {
    throw new ApiError(res.status, `${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}`);
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
 * header-less EventSource looks like) re-prompts for the key once per failure
 * streak, then reconnects with `?key=` when a key is available.
 *
 * Returns an unsubscribe function.
 */
export function subscribeEta(handler: EtaEventHandler): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: number | undefined;
  let attempt = 0;
  let promptedThisStreak = false;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    const key = getRouterKey();
    const url = key ? `/admin/events?key=${encodeURIComponent(key)}` : '/admin/events';
    source = new EventSource(url);

    source.addEventListener('eta', (ev: Event) => {
      attempt = 0;
      promptedThisStreak = false;
      try {
        handler(JSON.parse((ev as MessageEvent).data) as EtaEvent);
      } catch {
        // Malformed event payload; skip it.
      }
    });

    source.onerror = () => {
      if (stopped) return;
      // CLOSED = EventSource gave up (fatal, e.g. 401). CONNECTING = it is still
      // retrying on its own; we close it and take over with backoff either way.
      const fatal = source?.readyState === EventSource.CLOSED;
      source?.close();
      attempt += 1;
      const delay = Math.min(1000 * 2 ** attempt, 15000);
      if (fatal && !promptedThisStreak) {
        promptedThisStreak = true;
        void (async () => {
          await askForKey();
          if (!stopped) reconnectTimer = window.setTimeout(connect, delay);
        })();
        return;
      }
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    source?.close();
  };
}
