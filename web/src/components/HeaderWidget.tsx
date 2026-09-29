/**
 * Global header widget: live running-request indicator fed by the /admin/events
 * SSE stream and reconciled against GET /admin/eta every few seconds, plus a
 * stream-health dot and the theme switch.
 *
 * For the focused running request it shows
 *   "Running - <alias> - mm:ss - ~mm:ss left - N tok/s"
 * over a 2px progress bar whose width is elapsed / (elapsed + eta); while the
 * router is still estimating (etaMs null) it shows "~estimating...". The latest
 * terminal outcome ("Done in mm:ss" green / "Failed after mm:ss" red) lingers
 * for 10s once the stream goes idle, then collapses. The reconcile poll is what
 * keeps the indicator live when the SSE stream is unavailable (EventSource
 * cannot set the x-api-key header): it refreshes progress and drops tasks that
 * ended between polls as a neutral "Finished in mm:ss".
 */
import { ThemeSwitch } from '@lobehub/ui';
import { theme as antdTheme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api, subscribeEta } from '../api';
import { useThemeMode } from '../theme';
import type { EtaEvent, EtaSnapshot } from '../types';

const TERMINAL_LINGER_MS = 10_000;
const RECONCILE_MS = 3_000;

interface Tracked {
  event: EtaEvent;
  /** Date.now() when this event arrived; elapsed ticks locally between events. */
  recvAt: number;
}

/** mm:ss (minutes zero-padded); switches to h:mm:ss past one hour. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export default function HeaderWidget() {
  const { mode, setMode } = useThemeMode();
  const { token } = antdTheme.useToken();

  const runningRef = useRef(new Map<string, Tracked>());
  const focusedIdRef = useRef<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [terminal, setTerminal] = useState<{ event: EtaEvent; at: number; assumed?: boolean } | null>(
    null,
  );
  const [streamOk, setStreamOk] = useState<boolean | null>(null);

  const pickFocus = (): string | null => {
    const m = runningRef.current;
    const cur = focusedIdRef.current;
    if (cur && m.has(cur)) return cur;
    let best: string | null = null;
    let bestStart = -Infinity;
    for (const [id, t] of m) {
      if (t.event.startedAt > bestStart) {
        best = id;
        bestStart = t.event.startedAt;
      }
    }
    return best;
  };

  // 1s heartbeat so elapsed keeps ticking between SSE events.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Reconcile against the eta snapshot every few seconds, then consume the live
  // stream on top of it. The poll refreshes progress/eta and removes finished
  // tasks even when the SSE stream never delivers a terminal frame.
  useEffect(() => {
    let disposed = false;
    const reconcile = (): void => {
      // retry=false: the poll must not drive the key prompt (the pages do that
      // at a saner cadence); it just reflects the stored key's health.
      api<EtaSnapshot>('/admin/eta', {}, false)
        .then((snap) => {
          if (disposed) return;
          const at = Date.now();
          const m = runningRef.current;
          const seen = new Set(snap.running.map((ev) => ev.requestId));
          for (const ev of snap.running) m.set(ev.requestId, { event: ev, recvAt: at });
          for (const [id, t] of m) {
            if (seen.has(id)) continue;
            m.delete(id);
            // Gone from the snapshot without a terminal frame: it ended between
            // polls. Linger a neutral "Finished" so a focused task never runs on.
            if (focusedIdRef.current === id || m.size === 0) {
              const durationMs = t.event.elapsedMs + Math.max(0, at - t.recvAt);
              setTerminal({ event: { ...t.event, durationMs }, at, assumed: true });
            }
          }
          const id = pickFocus();
          focusedIdRef.current = id;
          setFocusedId(id);
          setStreamOk(true);
          setNow(at);
        })
        .catch(() => {
          if (!disposed) setStreamOk(false);
        });
    };

    reconcile();
    const poll = window.setInterval(reconcile, RECONCILE_MS);
    const unsub = subscribeEta((ev) => {
      const m = runningRef.current;
      if (ev.status === 'running') {
        m.set(ev.requestId, { event: ev, recvAt: Date.now() });
      } else {
        m.delete(ev.requestId);
        if (focusedIdRef.current === ev.requestId || m.size === 0) {
          setTerminal({ event: ev, at: Date.now() });
        }
      }
      const id = pickFocus();
      focusedIdRef.current = id;
      setFocusedId(id);
      setStreamOk(true);
      setNow(Date.now());
    });
    return () => {
      disposed = true;
      window.clearInterval(poll);
      unsub();
    };
  }, []);

  // Terminal banner lingers TERMINAL_LINGER_MS, then collapses.
  useEffect(() => {
    if (!terminal) return;
    const t = window.setTimeout(() => setTerminal(null), TERMINAL_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [terminal]);

  const focused = focusedId ? runningRef.current.get(focusedId) : undefined;
  const runningCount = runningRef.current.size;
  const showTerminal =
    !focused && terminal && now - terminal.at < TERMINAL_LINGER_MS ? terminal : null;

  let text: string;
  let color: string;
  let pct: number | null = null; // progress bar fill %, null = indeterminate/hidden
  let barColor: string | null = null;

  if (focused) {
    const ev = focused.event;
    const elapsed = ev.elapsedMs + Math.max(0, now - focused.recvAt);
    const eta = ev.etaMs;
    const parts = [`Running - ${ev.alias} - ${fmtClock(elapsed)}`];
    if (eta != null) {
      parts.push(`~${fmtClock(eta)} left`);
      pct = Math.min(100, Math.max(2, (elapsed / (elapsed + eta)) * 100));
    } else {
      parts.push('~estimating...');
    }
    if (ev.tokensPerSec != null) parts.push(`${Math.round(ev.tokensPerSec)} tok/s`);
    if (runningCount > 1) parts.push(`(${runningCount} running)`);
    text = parts.join(' - ');
    color = token.colorText;
    barColor = token.colorPrimary;
  } else if (showTerminal) {
    const ev = showTerminal.event;
    const dur = ev.durationMs ?? now - showTerminal.at;
    if (showTerminal.assumed) {
      // Ended between polls: the terminal status was never observed, stay neutral.
      text = `Finished in ${fmtClock(dur)}`;
      color = token.colorTextSecondary;
    } else {
      const done = ev.status === 'done';
      text = `${done ? 'Done in' : 'Failed after'} ${fmtClock(dur)}`;
      color = done ? token.colorSuccess : token.colorError;
    }
  } else {
    text = 'Idle';
    color = token.colorTextTertiary;
  }

  const dotColor =
    streamOk == null ? token.colorTextQuaternary : streamOk ? token.colorSuccess : token.colorError;
  const dotTitle =
    streamOk == null
      ? 'Connecting to the live stream...'
      : streamOk
        ? 'Live stream connected'
        : 'Live stream unreachable';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} title={dotTitle}>
        <span
          aria-hidden
          style={{
            flex: '0 0 auto',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor,
            opacity: streamOk === false ? 1 : 0.85,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color,
              fontWeight: 500,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {text}
          </div>
          <div
            style={{
              marginTop: 4,
              height: 2,
              width: 200,
              borderRadius: 1,
              overflow: 'hidden',
              background: token.colorFillSecondary,
            }}
          >
            {focused && (
              <div
                style={{
                  height: '100%',
                  width: pct == null ? '35%' : `${pct}%`,
                  opacity: pct == null ? 0.45 : 1,
                  background: barColor ?? token.colorPrimary,
                  transition: 'width 0.6s linear',
                }}
              />
            )}
          </div>
        </div>
      </div>
      <ThemeSwitch
        themeMode={mode}
        onThemeSwitch={(next) => {
          if (next === 'dark' || next === 'light') setMode(next);
        }}
        type="icon"
        variant="borderless"
        size="small"
      />
    </div>
  );
}
