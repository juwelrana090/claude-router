/** Number/time formatting shared by every page so the same value always reads the same way. */

const UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/** 58,761,495 -> "58.8M". Small numbers stay exact. Use fmtExact for the tooltip. */
export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  for (const [size, unit] of UNITS) {
    if (abs >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${unit}`.replace(/\.0+([A-Z])$/, '$1');
    }
  }
  return String(Math.round(n));
}

export function fmtExact(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US');
}

/** "58.8 million" for people who do not think in K/M/B at a glance. */
export function fmtWords(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)} billion`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)} million`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} thousand`;
  return String(Math.round(n));
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function fmtTps(tps: number | null | undefined): string {
  if (tps == null || !Number.isFinite(tps)) return '—';
  return tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** mm:ss, or h:mm:ss past one hour. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
}
