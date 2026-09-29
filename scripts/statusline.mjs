#!/usr/bin/env node
// Claude Code statusline: "provider/model - elapsed - ~ETA - session tokens - session cost".
// Reads ROUTER_PORT / ROUTER_KEY from the router .env (script dir/../.env or $ROUTER_HOME/.env).
// The key is only used in a request header - never echoed, logged or passed as argv.
// Always exits 0; prints "claude-router - offline" when the router is unreachable.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function envFromDotenv() {
  const home = process.env.ROUTER_HOME;
  const path = home
    ? join(home, ".env")
    : join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    // Same value rules as the router's own loader (src/config.ts): only a
    // whitespace-preceded '#' starts an inline comment, so keys may contain '#'.
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "");
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
envFromDotenv();

const port = process.env.ROUTER_PORT || "21450";
const key = process.env.ROUTER_KEY || "";

const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const toks = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

try {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2000);
  t.unref(); // a rejected fetch must not keep the process alive for the full 2s
  const res = await fetch(`http://127.0.0.1:${port}/admin/eta`, {
    headers: key ? { "x-api-key": key } : {},
    signal: ac.signal,
  });
  clearTimeout(t);
  if (!res.ok) throw new Error(String(res.status));
  const d = await res.json();
  const s = d.session;
  const tail = s
    ? ` - ${toks((s.tokensIn || 0) + (s.tokensOut || 0))} tok - $${(s.cost || 0).toFixed(4)}`
    : "";
  // longest-running entry (earliest start - same pick as the UI header widget)
  const r = (d.running || []).slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))[0];
  if (r) {
    const eta = r.etaMs == null ? "~estimating" : `~${fmt(r.etaMs)}`;
    console.log(`${r.provider}/${r.model} - ${fmt(r.elapsedMs)} - ${eta}${tail}`);
  } else {
    console.log(`claude-router - idle`);
  }
} catch {
  console.log(`claude-router - offline`);
}
