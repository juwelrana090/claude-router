/**
 * HTTP + SSE client for the claude-router admin API.
 *
 * Auth: the browser signs in once (username + password) and the server keeps an HttpOnly session
 * cookie, so fetch and EventSource are authenticated automatically. There is no key prompt any more.
 * A 401 fires the "router:unauthorized" window event; AuthProvider reacts by showing the sign-in page.
 */
import type { EtaEvent, EtaSnapshot, Snapshot, UsageRange, UsageSummary } from './types';

export const UNAUTHORIZED_EVENT = 'router:unauthorized';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Fetch JSON from the admin API. Errors carry the server's field-level reason. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const method = init.method ?? 'GET';
  // Non-GET calls need a JSON content type (the server refuses form posts); send one even without a body.
  if (method !== 'GET' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      const fieldMsgs = Array.isArray(data?.errors)
        ? data.errors.map((e: { field: string; message: string }) => `${e.field}: ${e.message}`).join('; ')
        : '';
      detail = fieldMsgs || data?.error?.message || detail;
    } catch {
      // body wasn't JSON — keep the generic status line
    }
    if (res.status === 401 && !path.startsWith('/admin/auth/')) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(res.status, `${method} ${path} failed: ${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- Contract endpoints ----------

export const fetchSnapshot = (): Promise<Snapshot> => api<Snapshot>('/admin/snapshot');
export const fetchEtaSnapshot = (): Promise<EtaSnapshot> => api<EtaSnapshot>('/admin/eta');
export const fetchUsageSummary = (range: UsageRange): Promise<UsageSummary> =>
  api<UsageSummary>(`/admin/usage/summary?range=${encodeURIComponent(range)}`);

// ---------- Live SSE (/admin/events) ----------

export type EtaEventHandler = (event: EtaEvent) => void;

/**
 * Subscribe to the "eta" SSE stream with auto-reconnect (exponential backoff, capped at 15s).
 * The session cookie authenticates it. Returns an unsubscribe function.
 */
export function subscribeEta(handler: EtaEventHandler): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: number | undefined;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    source = new EventSource('/admin/events');
    source.addEventListener('eta', (ev: Event) => {
      attempt = 0;
      try {
        handler(JSON.parse((ev as MessageEvent).data) as EtaEvent);
      } catch {
        // malformed payload; skip it
      }
    });
    source.onerror = () => {
      if (stopped) return;
      source?.close();
      attempt += 1;
      reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempt, 15000));
    };
  };
  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    source?.close();
  };
}
