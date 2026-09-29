#!/usr/bin/env node
// Local token/cost meter for claude-router.
//
// Reads logs/usage.jsonl (written by the proxy) and prints a per-model and
// per-provider breakdown. No network, no dependencies, no secrets are read.
//
//   node scripts/token-meter.mjs            last 24h
//   node scripts/token-meter.mjs 1h
//   node scripts/token-meter.mjs 7d
//   node scripts/token-meter.mjs all
//
// Run this BEFORE and AFTER any prompt/config change. Without a before/after
// number from here, an optimization is just a guess.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const RANGES = { "1h": 3.6e6, "24h": 8.64e7, "7d": 6.048e8, all: Infinity };
const arg = (process.argv[2] || "24h").toLowerCase();
const windowMs = RANGES[arg];
if (windowMs === undefined) {
  console.error(`usage: node scripts/token-meter.mjs [1h|24h|7d|all]  (got "${arg}")`);
  process.exit(2);
}

const home = process.env.ROUTER_HOME || path.resolve(import.meta.dirname, "..");
const file = path.join(home, "logs", "usage.jsonl");

if (!fs.existsSync(file)) {
  console.error(`No usage log at ${file}`);
  console.error("The router only writes it when Claude Code is actually pointed at the router.");
  console.error("Set ANTHROPIC_BASE_URL=http://127.0.0.1:<port> in ~/.claude/settings.json, then use the");
  console.error("tool normally for a while and re-run this. Nothing else is needed - do not fabricate a baseline.");
  process.exit(1);
}

const ZERO = () => ({ requests: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, cost: 0, errors: 0, ms: 0 });
const byModel = new Map();
const byProvider = new Map();
const bump = (map, k, e) => {
  const t = map.get(k) ?? { ...ZERO(), model: e.model, provider: e.provider };
  t.requests++;
  t.inTok += e.in || 0;
  t.outTok += e.out || 0;
  t.cacheRead += e.cacheRead || 0;
  t.cacheWrite += e.cacheWrite || 0;
  t.cost += e.cost || 0;
  t.ms += e.ms || 0;
  if (e.status >= 400) t.errors++;
  map.set(k, t);
};

const since = Date.now() - windowMs;
let scanned = 0, kept = 0, corrupt = 0, total = 0;

const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  scanned++;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    corrupt++;
    continue; // tolerate a half-written line from a hard kill
  }
  total++;
  const ts = Date.parse(e.ts);
  if (Number.isFinite(ts) && ts < since) continue;
  kept++;
  bump(byModel, e.alias || e.model || "?", e);
  bump(byProvider, e.provider || "?", e);
}

const num = (n) => n.toLocaleString("en-US");
const usd = (n) => "$" + n.toFixed(4);
const table = (title, map) => {
  if (!map.size) return;
  console.log(`\n${title}`);
  console.log("  " + "name".padEnd(22) + "req".padStart(6) + "in".padStart(10) + "out".padStart(9) +
              "cacheR".padStart(11) + "cacheW".padStart(10) + "err".padStart(5) + "avg".padStart(9) + "cost".padStart(11));
  for (const [name, t] of [...map].sort((a, b) => b[1].cost - a[1].cost || b[1].requests - a[1].requests)) {
    const avg = Math.round(t.ms / Math.max(1, t.requests));
    console.log("  " + name.padEnd(22) + num(t.requests).padStart(6) + num(t.inTok).padStart(10) +
      num(t.outTok).padStart(9) + num(t.cacheRead).padStart(11) + num(t.cacheWrite).padStart(10) +
      String(t.errors).padStart(5) + ((avg >= 1000 ? (avg / 1000).toFixed(1) + "s" : avg + "ms")).padStart(9) +
      usd(t.cost).padStart(11));
  }
};

console.log(`token-meter  range=${arg}  log=${file}`);
console.log(`lines: ${num(scanned)} scanned, ${num(kept)} in range, ${num(total)} lifetime, ${corrupt} corrupt skipped`);

if (!kept) {
  console.log("\nNo requests in this range. Widen the range (`all`) or use the tool for longer.");
  process.exit(0);
}

const sum = [...byModel.values()].reduce((a, t) => ({
  req: a.req + t.requests, i: a.i + t.inTok, o: a.o + t.outTok,
  cr: a.cr + t.cacheRead, cw: a.cw + t.cacheWrite, c: a.c + t.cost, e: a.e + t.errors,
}), { req: 0, i: 0, o: 0, cr: 0, cw: 0, c: 0, e: 0 });

const cacheable = sum.i + sum.cr + sum.cw;
const hit = cacheable ? (sum.cr / cacheable) * 100 : 0;
const totalTok = sum.i + sum.o + sum.cr + sum.cw;

console.log(`\nTOTALS  requests=${num(sum.req)}  errors=${num(sum.e)}  cost=${usd(sum.c)}`);
console.log(`  input       ${num(sum.i)}`);
console.log(`  output      ${num(sum.o)}`);
console.log(`  cache read  ${num(sum.cr)}`);
console.log(`  cache write ${num(sum.cw)}`);
console.log(`  all tokens  ${num(totalTok)}   $${(sum.c / Math.max(1, totalTok) * 1e6).toFixed(3)} per Mtok (blended)`);
console.log(`  cache hit   ${hit.toFixed(1)}%  of ${num(cacheable)} cacheable input tokens`);

table("BY MODEL", byModel);
table("BY PROVIDER", byProvider);

console.log("\nread: cache hit below ~60% means the system prompt is churning between requests;");
console.log("      output above ~30% of all tokens usually means a chatty habit, not a hard task.");
console.log("      'all' is cumulative, use it only for ratios, never for a before/after diff.");
