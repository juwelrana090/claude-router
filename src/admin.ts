import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  BACKUP_DIR, Config, ENV_FILE, ModelCfg, PORT, ProviderCfg, ROUTES_FILE,
  StaleVersionError, ValidationError, commitConfig, commitEnv, configVersion, envVersion,
  getCfg, readEnvText, validateEnvName, validateModelAlias, validateModelBody, validateNoCycle,
  validateProviderBody, validateProviderName,
} from "./config";
import { DATA_DIR, DB_FILE, SETTING_DEFAULTS, allSettings, db, setSetting } from "./db";
import { userCount } from "./auth";
import { budgetReason } from "./capacity";
import { clearMemory, deleteMemory, listMemory } from "./memory";
import * as history from "./history";
import {
  MAX_SSE_CLIENTS, RECENT_MAX, addClient, cooldownLeft, coolInfoFor, dropClient, inFlight,
  lastUsedKey, lastUsedProvider, providerRollup, recent, resetCooldown, rollup, sseClientCount,
} from "./live";
import { buildHeaders, keyOrder } from "./routing";
import * as eta from "./eta";

const LOG_FILE = path.join(process.env.ROUTER_HOME ?? path.resolve(__dirname, ".."), "logs", "usage.jsonl");

// ---------- small http helpers (duplicated from index.ts on purpose: admin.ts must
// stay importable without pulling in the proxy) ----------
function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function fail(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  sendJSON(res, status, { type: "error", error: { type, message }, ...extra });
}

const MAX_ADMIN_BODY = 1_000_000;

async function readJSONBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_ADMIN_BODY) throw new ValidationError([{ field: "body", message: "too large (max 1 MB)" }]);
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new ValidationError([{ field: "body", message: `invalid JSON: ${(e as Error).message}` }]);
  }
}

// ---------- guards ----------
// DNS-rebinding defence: the UI is loopback-only, so the Host header must be too.
export function hostAllowed(req: IncomingMessage): boolean {
  const host = header(req.headers.host);
  if (!host) return false;
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  return allowed.has(host);
}

function header(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(",") : v;
}

// Cross-origin state changes are refused. Same-origin requests from the UI carry
// an Origin header; a missing Origin (curl, Claude Code) is allowed.
export function originAllowed(req: IncomingMessage): boolean {
  const origin = header(req.headers.origin);
  if (!origin || origin === "null") return true;
  const allowed = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  return allowed.has(origin);
}

// ---------- secret masking: the API never returns a key value ----------
interface KeyView {
  envName: string;
  configured: boolean;
  last4: string;
  cooldownSeconds: number;
  cooling: boolean;
  cooldownReason: string | null;
  lastUsed?: number;
}

function keyView(envName: string): KeyView {
  const v = process.env[envName];
  const left = cooldownLeft(envName);
  return {
    envName,
    configured: !!v,
    last4: v ? v.slice(-4) : "",
    cooldownSeconds: Math.ceil(left / 1000),
    cooling: left > 0,
    cooldownReason: left > 0 ? (coolInfoFor(envName)?.reason ?? null) : null,
    lastUsed: lastUsedKey(envName),
  };
}

function providerView(name: string, p: ProviderCfg) {
  const keyless = p.auth === "none";
  const keys = p.keys.map(keyView);
  return {
    keyless,
    name,
    baseURL: p.baseURL,
    auth: p.auth,
    dropBeta: !!p.dropBeta,
    dropBodyFields: p.dropBodyFields ?? [],
    disabled: !!p.disabled,
    keys,
    keysTotal: keyless ? 1 : keys.length,
    keysHealthy: keyless ? 1 : keys.filter((k) => k.configured && !k.cooling).length,
    models: Object.keys(getCfg().models).filter((a) => getCfg().models[a].provider === name),
    lastUsed: lastUsedProvider(name),
    last5m: providerRollup(name, 5),
    dailyRequests: p.dailyRequests ?? null,
    dailyTokens: p.dailyTokens ?? null,
    today: history.providerToday(name),
    budgetReason: budgetReason(name, p),
  };
}

/**
 * Optional { newKey: { value, envName? } } on model create/update: the secret is added to the provider's
 * key list, written to .env, and the model is pinned to it, all in ONE version-checked save.
 */
function withNewKey(
  c: Config, body: Record<string, unknown>, providerName: string | undefined,
): { cfg: Config; body: Record<string, unknown>; env?: Record<string, string>; envName?: string } {
  if (body.newKey === undefined || body.newKey === null) return { cfg: c, body };
  const nk = (typeof body.newKey === "object" ? body.newKey : {}) as Record<string, unknown>;
  const p = providerName ? c.providers[providerName] : undefined;
  if (!providerName || !p) throw new ValidationError([{ field: "provider", message: "choose a provider before adding a key" }]);
  if (p.auth === "none") {
    throw new ValidationError([{ field: "newKey", message: `provider "${providerName}" needs no key (auth: none)` }]);
  }
  const value = typeof nk.value === "string" ? nk.value.trim() : "";
  if (value.length < 4) throw new ValidationError([{ field: "newKey.value", message: "paste the API key (at least 4 characters)" }]);
  const owner = new Map<string, string>();
  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) owner.set(k, pn);
  let envName = typeof nk.envName === "string" ? nk.envName.trim() : "";
  if (envName) {
    validateEnvName(envName, "newKey.envName");
    if (owner.has(envName) && owner.get(envName) !== providerName) {
      throw new ValidationError([{ field: "newKey.envName", message: `"${envName}" already belongs to provider "${owner.get(envName)}"` }]);
    }
  } else {
    const base = providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    let n = 1;
    while (owner.has(`${base}_KEY_${n}`)) n++;
    envName = `${base}_KEY_${n}`;
  }
  const keys = p.keys.includes(envName) ? p.keys : [...p.keys, envName];
  const cfg: Config = { ...c, providers: { ...c.providers, [providerName]: { ...p, keys } } };
  return { cfg, body: { ...body, key: envName }, env: { [envName]: value }, envName };
}

function modelView(alias: string, m: ModelCfg) {
  const p = getCfg().providers[m.provider];
  const keyless = p?.auth === "none";
  const keys = m.key ? [keyView(m.key)] : (p?.keys ?? []).map(keyView);
  return {
    alias,
    ...m,
    fallback: m.fallback ?? [],
    price: m.price ?? null,
    providerMissing: !p,
    providerDisabled: !!p?.disabled,
    keysHealthy: keyless ? 1 : keys.filter((k) => k.configured && !k.cooling).length,
    keysTotal: keyless ? 1 : keys.length,
    lastUsed: lastUsedProvider(m.provider),
  };
}

// ---------- snapshot ----------
export function snapshot() {
  const c = getCfg();
  return {
    ts: Date.now(),
    version: configVersion(),
    envVersion: envVersion(),
    port: PORT,
    defaultModel: c.defaultModel ?? null,
    aliases: c.aliases ?? {},
    providers: Object.entries(c.providers).map(([n, p]) => providerView(n, p)),
    models: Object.entries(c.models).map(([a, m]) => modelView(a, m)),
    inFlight: [...inFlight.values()],
    recent: recent.slice(-RECENT_MAX),
    counters: { m1: rollup(1), m5: rollup(5), h1: rollup(60) },
    cooldowns: Object.fromEntries(
      [...new Set(Object.values(c.providers).flatMap((p) => p.keys))].map((k) => [k, cooldownLeft(k)])
    ),
    session: eta.activeSession(),
    sseClients: sseClientCount(),
    routesFile: ROUTES_FILE,
    envFile: ENV_FILE,
    backupDir: BACKUP_DIR,
  };
}

// ---------- referential integrity ----------
function modelReferences(c: Config, alias: string): { type: string; name: string }[] {
  const refs: { type: string; name: string }[] = [];
  if (c.defaultModel === alias) refs.push({ type: "defaultModel", name: "defaultModel" });
  for (const [slot, target] of Object.entries(c.aliases ?? {})) {
    if (target === alias) refs.push({ type: "alias", name: slot });
  }
  for (const [name, m] of Object.entries(c.models)) {
    if (name === alias) continue;
    if (m.fallback?.includes(alias)) refs.push({ type: "fallback", name });
  }
  return refs;
}

function cleanModelReferences(c: Config, removed: Set<string>): string[] {
  const changed: string[] = [];
  const aliases = { ...(c.aliases ?? {}) };
  for (const [slot, target] of Object.entries(aliases)) {
    if (removed.has(target)) {
      delete aliases[slot];
      changed.push(`aliases.${slot}`);
    }
  }
  if (removed.has(c.defaultModel ?? "")) {
    changed.push("defaultModel");
    delete c.defaultModel;
  }
  for (const [name, m] of Object.entries(c.models)) {
    if (!m.fallback?.some((f) => removed.has(f))) continue;
    m.fallback = m.fallback.filter((f) => !removed.has(f));
    if (!m.fallback.length) delete m.fallback;
    changed.push(`models.${name}.fallback`);
  }
  c.aliases = aliases;
  return [...new Set(changed)];
}

// ---------- usage summary (streams usage.jsonl, tolerates corrupt lines) ----------
const RANGES: Record<string, { ms: number; bucket: number; label: string }> = {
  "1h": { ms: 3_600_000, bucket: 5 * 60_000, label: "5 min" },
  "24h": { ms: 86_400_000, bucket: 60 * 60_000, label: "1 hour" },
  "7d": { ms: 7 * 86_400_000, bucket: 6 * 60 * 60_000, label: "6 hours" },
  "30d": { ms: 30 * 86_400_000, bucket: 24 * 60 * 60_000, label: "1 day" },
};

interface Agg {
  requests: number;
  errors: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  msSum: number;
  timed: number;
  tpsSum: number;
  tpsCount: number;
}

const newAgg = (): Agg => ({
  requests: 0, errors: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  msSum: 0, timed: 0, tpsSum: 0, tpsCount: 0,
});

function addTo(a: Agg, line: any, cost: number): void {
  a.requests++;
  if (typeof line.status === "number" && line.status >= 400) a.errors++;
  a.in += Number(line.in) || 0;
  a.out += Number(line.out) || 0;
  a.cacheRead += Number(line.cacheRead) || 0;
  a.cacheWrite += Number(line.cacheWrite) || 0;
  a.cost += cost;
  const ms = Number(line.durationMs ?? line.ms) || 0; // legacy lines fall back to ms
  if (ms > 0) {
    a.msSum += ms;
    a.timed++;
  }
  const tps = Number(line.outputTokensPerSec) || 0; // old data dilutes nothing with zeros
  if (tps > 0) {
    a.tpsSum += tps;
    a.tpsCount++;
  }
}

const timingOf = (a: Agg) => ({
  avgMs: a.timed ? Math.round(a.msSum / a.timed) : 0,
  avgTokensPerSec: a.tpsCount ? Math.round((a.tpsSum / a.tpsCount) * 10) / 10 : 0,
});

function finishAgg(a: Agg) {
  const denom = a.in + a.cacheRead + a.cacheWrite;
  return {
    ...a,
    cacheHitRatio: denom ? a.cacheRead / denom : 0,
    errorRate: a.requests ? a.errors / a.requests : 0,
    cost: Math.round(a.cost * 1e6) / 1e6,
    ...timingOf(a),
  };
}

async function usageSummary(range: string) {
  const spec = RANGES[range] ?? RANGES["1h"];
  const since = Date.now() - spec.ms;
  const c = getCfg();

  const byAlias = new Map<string, Agg>();
  const byProvider = new Map<string, Agg>();
  const timeline = new Map<number, Agg>();
  const daily = new Map<string, Agg>();
  const monthly = new Map<string, Agg>();
  const top: { ts: number; alias: string; provider: string; model: string; in: number; out: number; cost: number }[] = [];

  if (!fs.existsSync(LOG_FILE)) {
    return {
      range,
      bucketLabel: spec.label,
      totals: finishAgg(newAgg()),
      byAlias: [],
      byProvider: [],
      timeline: [],
      daily: [],
      monthly: [],
      top: [],
      corruptLines: 0,
      logFile: LOG_FILE,
    };
  }

  let corrupt = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(LOG_FILE, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      corrupt++;
      continue;
    }
    const ts = Date.parse(rec.ts);
    if (!Number.isFinite(ts) || ts < since) continue;

    const m = c.models[rec.alias];
    const price = m?.price;
    const cost = price
      ? ((Number(rec.in) || 0) * price.in +
          (Number(rec.out) || 0) * price.out +
          (Number(rec.cacheRead) || 0) * (price.cacheRead ?? price.in)) / 1e6
      : Number(rec.cost) || 0;

    addTo(byAlias.get(rec.alias) ?? (byAlias.set(rec.alias, newAgg()).get(rec.alias)!), rec, cost);
    const prov = rec.provider ?? m?.provider ?? "unknown";
    addTo(byProvider.get(prov) ?? (byProvider.set(prov, newAgg()).get(prov)!), rec, cost);
    const b = Math.floor(ts / spec.bucket) * spec.bucket;
    addTo(timeline.get(b) ?? (timeline.set(b, newAgg()).get(b)!), rec, cost);

    // Per-day and per-month rollups (provider x alias) inside the selected range.
    const day = new Date(ts).toISOString().slice(0, 10);
    const model = rec.model ?? "";
    const dKey = `${day}\u0000${prov}\u0000${rec.alias}\u0000${model}`;
    addTo(daily.get(dKey) ?? (daily.set(dKey, newAgg()).get(dKey)!), rec, cost);
    const mKey = `${day.slice(0, 7)}\u0000${prov}\u0000${rec.alias}\u0000${model}`;
    addTo(monthly.get(mKey) ?? (monthly.set(mKey, newAgg()).get(mKey)!), rec, cost);

    if ((Number(rec.in) || 0) + (Number(rec.out) || 0) > 0) {
      top.push({
        ts,
        alias: rec.alias,
        provider: prov,
        model: rec.model ?? "",
        in: Number(rec.in) || 0,
        out: Number(rec.out) || 0,
        cost: Math.round(cost * 1e6) / 1e6,
      });
    }
  }

  const total = newAgg();
  for (const a of byAlias.values()) {
    total.requests += a.requests;
    total.errors += a.errors;
    total.in += a.in;
    total.out += a.out;
    total.cacheRead += a.cacheRead;
    total.cacheWrite += a.cacheWrite;
    total.cost += a.cost;
    total.msSum += a.msSum;
    total.timed += a.timed;
    total.tpsSum += a.tpsSum;
    total.tpsCount += a.tpsCount;
  }

  return {
    range,
    bucketLabel: spec.label,
    totals: finishAgg(total),
    byAlias: [...byAlias.entries()]
      .map(([alias, a]) => ({ name: alias, provider: c.models[alias]?.provider ?? null, ...finishAgg(a) }))
      .sort((x, y) => y.requests - x.requests),
    byProvider: [...byProvider.entries()]
      .map(([name, a]) => ({ name, ...finishAgg(a) }))
      .sort((x, y) => y.requests - x.requests),
    timeline: [...timeline.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, a]) => ({ ts, requests: a.requests, in: a.in, out: a.out, cost: Math.round(a.cost * 1e6) / 1e6 })),
    daily: [...daily.entries()]
      .map(([k, a]) => {
        const [day, provider, alias, model] = k.split("\u0000");
        return { day, provider, alias, model, requests: a.requests, ...timingOf(a) };
      })
      .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : y.requests - x.requests)),
    monthly: [...monthly.entries()]
      .map(([k, a]) => {
        const [month, provider, alias, model] = k.split("\u0000");
        return { month, provider, alias, model, requests: a.requests, ...timingOf(a) };
      })
      .sort((x, y) => (x.month < y.month ? -1 : x.month > y.month ? 1 : y.requests - x.requests)),
    top: top.sort((a, b) => b.in + b.out - (a.in + a.out)).slice(0, 10),
    corruptLines: corrupt,
    logFile: LOG_FILE,
  };
}

// ---------- handlers ----------
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: string[]
) => void | Promise<void>;

function expectVersion(body: Record<string, unknown>): string {
  const v = body.version;
  if (typeof v !== "string" || !v) {
    throw new ValidationError([
      { field: "version", message: "required: send the version you loaded (optimistic concurrency)" },
    ]);
  }
  return v;
}

/** Commit a mutated config: backup + atomic write + reload + cooldown clear. */
function commit(next: Config, version: string, touchedKeys: string[] = []): void {
  commitConfig(next, version);
  for (const k of touchedKeys) resetCooldown(k);
  console.log(`[ADMIN] routes.json updated (${Object.keys(next.models).length} models)`);
}

const routes: Array<[string, RegExp, Handler]> = [];
const on = (method: string, pattern: RegExp, handler: Handler): void => {
  routes.push([method, pattern, handler]);
};

// ---- snapshot + events ----
on("GET", /^\/admin\/snapshot$/, (_req, res) => sendJSON(res, 200, snapshot()));

// Live task time / ETA: running requests + the active session (statusline + UI).
on("GET", /^\/admin\/eta$/, (_req, res) => sendJSON(res, 200, eta.etaSnapshot()));

on("GET", /^\/admin\/events$/, async (req, res) => {
  if (sseClientCount() >= MAX_SSE_CLIENTS) {
    return fail(res, 429, "rate_limit_error", `Too many UI connections (max ${MAX_SSE_CLIENTS}). Poll /admin/snapshot instead.`);
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`retry: 2000\n\n`);
  const id = addClient(res);
  if (id === undefined) {
    res.end(`event: full\ndata: {"reason":"too many clients"}\n\n`);
    return;
  }
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);

  const tick = setInterval(() => {
    try {
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    } catch {
      /* closed */
    }
  }, 1000);

  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* closed */
    }
  }, 15000);

  const close = (): void => {
    clearInterval(tick);
    clearInterval(ping);
    dropClient(id);
  };
  req.on("close", close);
  res.on("close", close);
  res.on("error", close);
});

// ---- providers ----
on("GET", /^\/admin\/providers$/, (_req, res) => {
  const c = getCfg();
  sendJSON(res, 200, { version: configVersion(), providers: Object.entries(c.providers).map(([n, p]) => providerView(n, p)) });
});

on("POST", /^\/admin\/providers$/, async (req, res) => {
  const body = await readJSONBody(req);
  const name = validateProviderName(body.name);
  const c = getCfg();
  if (c.providers[name]) throw new ValidationError([{ field: "name", message: `"${name}" already exists` }]);
  const version = expectVersion(body);
  const cfg = validateProviderBody(body);

  // Keys can be given right here: { envName?, value? } rows. A row with a value is written to .env;
  // a row with only an envName attaches a variable that already exists in .env.
  const rawKeys = body.keys === undefined ? [] : body.keys;
  if (!Array.isArray(rawKeys)) throw new ValidationError([{ field: "keys", message: "must be a list" }]);
  if (cfg.auth === "none" && rawKeys.length) {
    throw new ValidationError([{ field: "keys", message: 'must be empty when auth is "none" (no key needed)' }]);
  }
  const taken = new Map<string, string>();
  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) taken.set(k, pn);
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const keys: string[] = [];
  const setEnv: Record<string, string> = {};
  const errors: { field: string; message: string }[] = [];
  rawKeys.forEach((row: unknown, i: number) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const value = typeof r.value === "string" ? r.value.trim() : "";
    let envName = typeof r.envName === "string" && r.envName.trim() ? r.envName.trim() : "";
    if (!envName) {
      let n = 1;
      while (taken.has(`${base}_KEY_${n}`) || keys.includes(`${base}_KEY_${n}`)) n++;
      envName = `${base}_KEY_${n}`;
    }
    try { validateEnvName(envName, `keys.${i}.envName`); } catch (e) { errors.push(...(e as ValidationError).errors); return; }
    if (taken.has(envName) || keys.includes(envName)) {
      errors.push({ field: `keys.${i}.envName`, message: `"${envName}" is already used${taken.has(envName) ? ` by provider "${taken.get(envName)}"` : " in this list"}` });
      return;
    }
    if (value && value.length < 4) { errors.push({ field: `keys.${i}.value`, message: "must be at least 4 characters" }); return; }
    if (!value && !envNamesInFile().has(envName)) {
      errors.push({ field: `keys.${i}.value`, message: `is required (there is no ${envName} in .env to attach)` });
      return;
    }
    keys.push(envName);
    if (value) setEnv[envName] = value;
  });
  if (errors.length) throw new ValidationError(errors);

  const next: Config = { ...c, providers: { ...c.providers, [name]: { ...cfg, keys } } };
  commit(next, version);
  if (Object.keys(setEnv).length) commitEnv(setEnv, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
  for (const k of keys) resetCooldown(k);
  sendJSON(res, 201, { version: configVersion(), envVersion: envVersion(), provider: providerView(name, getCfg().providers[name]) });
});

on("GET", /^\/admin\/providers\/([^/]+)$/, (_req, res, [name]) => {
  const c = getCfg();
  const p = c.providers[name];
  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  sendJSON(res, 200, { version: configVersion(), provider: providerView(name, p) });
});

on("PUT", /^\/admin\/providers\/([^/]+)$/, async (req, res, [name]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const p = c.providers[name];
  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  if (body.name !== undefined && body.name !== name) {
    throw new ValidationError([
      { field: "name", message: "provider names are immutable; create a new one instead" },
    ]);
  }
  const version = expectVersion(body);
  const updated = validateProviderBody(body, p);
  const next: Config = { ...c, providers: { ...c.providers, [name]: { ...updated, keys: p.keys } } };
  commit(next, version, p.keys);
  sendJSON(res, 200, { version: configVersion(), provider: providerView(name, next.providers[name]) });
});

on("DELETE", /^\/admin\/providers\/([^/]+)$/, (req, res, [name]) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const cascade = url.searchParams.get("cascade") === "1";
  const c = getCfg();
  const p = c.providers[name];
  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  const version = req.headers["x-config-version"];
  if (typeof version !== "string" || !version) {
    return fail(res, 400, "invalid_request_error", "Send the config version in the x-config-version header");
  }
  const usedBy = Object.entries(c.models)
    .filter(([, m]) => m.provider === name)
    .map(([alias]) => ({ type: "model", name: alias }));
  if (usedBy.length && !cascade) {
    return fail(res, 409, "conflict_error", `"${name}" is still used by ${usedBy.length} model(s)`, {
      blockedBy: usedBy,
      hint: "Repeat with ?cascade=1 to delete those models and clean every reference.",
    });
  }
  const removed = new Set(usedBy.map((u) => u.name));
  const models = { ...c.models };
  for (const alias of removed) delete models[alias];
  const next: Config = { ...c, providers: { ...c.providers }, models };
  delete next.providers[name];
  const cleaned = cleanModelReferences(next, removed);
  commit(next, version, p.keys);
  sendJSON(res, 200, {
    version: configVersion(),
    deleted: { provider: name, models: [...removed] },
    cleanedReferences: cleaned,
  });
});

on("POST", /^\/admin\/providers\/([^/]+)\/enable$/, async (req, res, [name]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  if (!c.providers[name]) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  const version = expectVersion(body);
  commit({ ...c, providers: { ...c.providers, [name]: { ...c.providers[name], disabled: false } } }, version);
  sendJSON(res, 200, { version: configVersion(), provider: providerView(name, getCfg().providers[name]) });
});

on("POST", /^\/admin\/providers\/([^/]+)\/disable$/, async (req, res, [name]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  if (!c.providers[name]) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  const version = expectVersion(body);
  commit({ ...c, providers: { ...c.providers, [name]: { ...c.providers[name], disabled: true } } }, version);
  sendJSON(res, 200, { version: configVersion(), provider: providerView(name, getCfg().providers[name]) });
});

// ---- keys (values are write-only: they only ever land in .env) ----
on("POST", /^\/admin\/providers\/([^/]+)\/keys$/, async (req, res, [name]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const p = c.providers[name];
  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  const version = expectVersion(body);
  const envName = validateEnvName(body.envName);
  const value = body.value;
  if (typeof value !== "string" || value.length < 4) {
    throw new ValidationError([{ field: "value", message: "is required (min 4 chars)" }]);
  }
  const exists = p.keys.includes(envName);
  if (!exists && c.models) {
    for (const [alias, m] of Object.entries(c.models)) {
      if (m.key === envName && m.provider !== name) {
        throw new ValidationError([
          { field: "envName", message: `"${envName}" is pinned by model "${alias}" of provider "${m.provider}"` },
        ]);
      }
    }
  }
  const next: Config = {
    ...c,
    providers: {
      ...c.providers,
      [name]: { ...p, keys: exists ? p.keys : [...p.keys, envName] },
    },
  };
  commit(next, version);
  commitEnv({ [envName]: value }, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
  resetCooldown(envName);
  console.log(`[ADMIN] ${exists ? "replaced" : "added"} key ${envName} for provider ${name}`);
  sendJSON(res, exists ? 200 : 201, {
    version: configVersion(),
    envVersion: envVersion(),
    key: keyView(envName),
    provider: providerView(name, getCfg().providers[name]),
  });
});

// ---- OAuth (PKCE) key acquisition — currently only OpenRouter publishes a public,
// no-registration flow for this. Exchanges a browser-obtained authorization code for a
// real API key server-side (avoids exposing the exchange call to the page's CSP), then
// stores it exactly like a manually pasted key (same commit/commitEnv path as .../keys).
const OAUTH_TOKEN_URL: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/auth/keys",
};

on("POST", /^\/admin\/providers\/([^/]+)\/oauth\/exchange$/, async (req, res, [name]) => {
  const tokenUrl = OAUTH_TOKEN_URL[name];
  if (!tokenUrl)
    return fail(res, 400, "invalid_request_error", `Provider "${name}" has no OAuth flow`);
  const body = await readJSONBody(req);
  const c = getCfg();
  const p = c.providers[name];
  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  const version = expectVersion(body);
  const envName = validateEnvName(body.envName);
  const code = body.code;
  const codeVerifier = body.codeVerifier;
  if (typeof code !== "string" || !code)
    throw new ValidationError([{ field: "code", message: "is required" }]);
  if (typeof codeVerifier !== "string" || !codeVerifier)
    throw new ValidationError([{ field: "codeVerifier", message: "is required" }]);

  let value: string;
  try {
    const up = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: "S256",
      }),
    });
    const data: any = await up.json().catch(() => ({}));
    const key = data?.key ?? data?.data?.key;
    if (!up.ok || typeof key !== "string") {
      return fail(
        res,
        502,
        "api_error",
        `${name} OAuth exchange failed: ${up.status} ${JSON.stringify(data).slice(0, 300)}`,
      );
    }
    value = key;
  } catch (e) {
    return fail(res, 502, "api_error", `${name} OAuth exchange unreachable: ${(e as Error).message}`);
  }

  const exists = p.keys.includes(envName);
  if (!exists && c.models) {
    for (const [alias, m] of Object.entries(c.models)) {
      if (m.key === envName && m.provider !== name) {
        throw new ValidationError([
          { field: "envName", message: `"${envName}" is pinned by model "${alias}" of provider "${m.provider}"` },
        ]);
      }
    }
  }
  const next: Config = {
    ...c,
    providers: {
      ...c.providers,
      [name]: { ...p, keys: exists ? p.keys : [...p.keys, envName] },
    },
  };
  commit(next, version);
  commitEnv({ [envName]: value }, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
  resetCooldown(envName);
  console.log(`[ADMIN] ${exists ? "replaced" : "added"} key ${envName} for provider ${name} via OAuth`);
  sendJSON(res, exists ? 200 : 201, {
    version: configVersion(),
    envVersion: envVersion(),
    key: keyView(envName),
    provider: providerView(name, getCfg().providers[name]),
  });
});

on("DELETE", /^\/admin\/providers\/([^/]+)\/keys\/([^/]+)$/, async (req, res, [name, envName]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const p = c.providers[name];
  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  if (!p.keys.includes(envName)) {
    return fail(res, 404, "not_found_error", `Provider "${name}" has no key ${envName}`);
  }
  const pinnedBy = Object.entries(c.models)
    .filter(([, m]) => m.key === envName)
    .map(([alias]) => alias);
  const cascade = new URL(req.url ?? "/", "http://localhost").searchParams.get("cascade") === "1";
  if (pinnedBy.length && !cascade) {
    return fail(res, 409, "conflict_error", `${envName} is pinned by model(s): ${pinnedBy.join(", ")}`, {
      blockedBy: pinnedBy.map((n) => ({ type: "pinned-key", name: n })),
      hint: "Repeat with ?cascade=1 to unpin those models.",
    });
  }
  const version = expectVersion(body);
  const models = { ...c.models };
  for (const alias of pinnedBy) delete models[alias].key;
  commit({ ...c, providers: { ...c.providers, [name]: { ...p, keys: p.keys.filter((k) => k !== envName) } }, models }, version);
  commitEnv({}, [envName], typeof body.envVersion === "string" ? body.envVersion : undefined);
  console.log(`[ADMIN] removed key ${envName} from provider ${name}`);
  sendJSON(res, 200, { version: configVersion(), envVersion: envVersion(), unpinned: pinnedBy });
});

// ---- models ----
on("GET", /^\/admin\/models$/, (_req, res) => {
  const c = getCfg();
  sendJSON(res, 200, {
    version: configVersion(),
    models: Object.entries(c.models).map(([a, m]) => modelView(a, m)),
    providers: Object.keys(c.providers),
  });
});

on("POST", /^\/admin\/models$/, async (req, res) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const alias = validateModelAlias(body.alias);
  if (c.models[alias]) throw new ValidationError([{ field: "alias", message: `"${alias}" already exists` }]);
  const version = expectVersion(body);
  const nk = withNewKey(c, body, typeof body.provider === "string" ? body.provider : undefined);
  const m = validateModelBody(nk.body, nk.cfg);
  const next: Config = { ...nk.cfg, models: { ...nk.cfg.models, [alias]: m } };
  validateNoCycle(next.models, alias);
  commit(next, version);
  if (nk.env) {
    commitEnv(nk.env, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
    resetCooldown(nk.envName as string);
  }
  sendJSON(res, 201, { version: configVersion(), envVersion: envVersion(), model: modelView(alias, getCfg().models[alias]) });
});

on("GET", /^\/admin\/models\/([^/]+)$/, (_req, res, [alias]) => {
  const c = getCfg();
  const m = c.models[alias];
  if (!m) return fail(res, 404, "not_found_error", `No model "${alias}"`);
  sendJSON(res, 200, { version: configVersion(), model: modelView(alias, m) });
});

on("PUT", /^\/admin\/models\/([^/]+)$/, async (req, res, [alias]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const m = c.models[alias];
  if (!m) return fail(res, 404, "not_found_error", `No model "${alias}"`);
  if (body.alias !== undefined && body.alias !== alias) {
    throw new ValidationError([{ field: "alias", message: "model aliases are immutable; create a new one" }]);
  }
  const version = expectVersion(body);
  const nk = withNewKey(c, body, typeof body.provider === "string" ? body.provider : m.provider);
  const updated = validateModelBody(nk.body, nk.cfg, m);
  const next: Config = { ...nk.cfg, models: { ...nk.cfg.models, [alias]: updated } };
  validateNoCycle(next.models, alias);
  commit(next, version);
  if (nk.env) {
    commitEnv(nk.env, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
    resetCooldown(nk.envName as string);
  }
  sendJSON(res, 200, { version: configVersion(), envVersion: envVersion(), model: modelView(alias, getCfg().models[alias]) });
});

on("DELETE", /^\/admin\/models\/([^/]+)$/, async (req, res, [alias]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  if (!c.models[alias]) return fail(res, 404, "not_found_error", `No model "${alias}"`);
  const version = expectVersion(body);
  const cascade = new URL(req.url ?? "/", "http://localhost").searchParams.get("cascade") === "1";
  const refs = modelReferences(c, alias);
  if (refs.length && !cascade) {
    return fail(res, 409, "conflict_error", `"${alias}" is still referenced`, {
      blockedBy: refs,
      hint: "Repeat with ?cascade=1 to clean those references.",
    });
  }
  const models = { ...c.models };
  delete models[alias];
  const next: Config = { ...c, models };
  const cleaned = refs.length ? cleanModelReferences(next, new Set([alias])) : [];
  commit(next, version);
  sendJSON(res, 200, { version: configVersion(), deleted: alias, cleanedReferences: cleaned });
});

// ---- settings ----
on("GET", /^\/admin\/settings$/, (_req, res) => {
  const c = getCfg();
  sendJSON(res, 200, {
    version: configVersion(),
    envVersion: envVersion(),
    defaultModel: c.defaultModel ?? "",
    aliases: { opus: "", sonnet: "", haiku: "", ...(c.aliases ?? {}) },
    models: Object.keys(c.models),
  });
});

on("PUT", /^\/admin\/settings$/, async (req, res) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const version = expectVersion(body);
  const errors: { field: string; message: string }[] = [];
  const aliases: Record<string, string> = { ...(c.aliases ?? {}) };

  let defaultModel = c.defaultModel;
  if (body.defaultModel !== undefined) {
    const d = String(body.defaultModel);
    if (d && !c.models[d]) errors.push({ field: "defaultModel", message: `"${d}" is not a known model` });
    defaultModel = d || undefined;
  }
  const rawAliases = (body.aliases ?? {}) as Record<string, unknown>;
  for (const slot of ["opus", "sonnet", "haiku"]) {
    if (rawAliases[slot] === undefined) continue;
    const v = String(rawAliases[slot]);
    if (v && !c.models[v]) errors.push({ field: `aliases.${slot}`, message: `"${v}" is not a known model` });
    if (v) aliases[slot] = v;
    else delete aliases[slot];
  }
  if (errors.length) throw new ValidationError(errors);

  const next: Config = { ...c, aliases, ...(defaultModel ? { defaultModel } : {}) };
  if (!defaultModel) delete next.defaultModel;
  commit(next, version);
  sendJSON(res, 200, { version: configVersion(), defaultModel: getCfg().defaultModel ?? "", aliases: getCfg().aliases ?? {} });
});

// ---- cooldown reset ----
on("POST", /^\/admin\/keys\/([^/]+)\/reset-cooldown$/, (_req, res, [envName]) => {
  const existed = resetCooldown(envName);
  sendJSON(res, 200, { envName, cleared: existed, key: keyView(envName) });
});

// ---- the ONLY endpoint that is allowed to call an upstream provider ----
on("POST", /^\/admin\/models\/([^/]+)\/test$/, async (req, res, [alias]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const m = c.models[alias];
  if (!m) return fail(res, 404, "not_found_error", `No model "${alias}"`);
  const p = c.providers[m.provider];
  if (!p) return fail(res, 400, "invalid_request_error", `Model "${alias}" points at unknown provider "${m.provider}"`);
  if (body.confirm !== true) {
    return fail(res, 400, "invalid_request_error", 'Send {"confirm":true} - this call costs a few tokens');
  }
  if (p.disabled) return fail(res, 400, "invalid_request_error", `Provider "${m.provider}" is disabled`);
  const keys = keyOrder(p, m, "test");
  if (!keys.length) {
    return fail(res, 400, "invalid_request_error", `Provider "${m.provider}" has no configured key`);
  }
  const keyName = keys[0];
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const up = await fetch(`${p.baseURL}/v1/messages`, {
      method: "POST",
      headers: buildHeaders(req, p, keyName),
      body: JSON.stringify({ model: m.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: ac.signal,
    });
    const text = await up.text();
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.content?.[0]?.text ?? detail;
    } catch {
      /* not JSON */
    }
    // Deliberately NOT recorded in usage.jsonl: it is a diagnostic, not real traffic.
    sendJSON(res, 200, {
      ok: up.ok,
      status: up.status,
      ms: Date.now() - started,
      provider: m.provider,
      model: m.model,
      key: keyView(keyName),
      detail,
    });
  } catch (e) {
    sendJSON(res, 200, {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      provider: m.provider,
      model: m.model,
      key: keyView(keyName),
      detail: ac.signal.aborted ? "timed out after 20s" : (e as Error).message,
    });
  } finally {
    clearTimeout(timer);
  }
});

// ---- usage summary ----
on("GET", /^\/admin\/usage\/summary$/, async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  sendJSON(res, 200, await usageSummary(url.searchParams.get("range") ?? "1h"));
});

// ---- entry point used by index.ts ----

// ---------- .env key discovery ----------
/** Variable NAMES defined in the .env file (never values, never the process environment). */
function envNamesInFile(): Set<string> {
  const out = new Set<string>();
  for (const line of readEnvText().split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out.add(t.slice(0, i).trim());
  }
  return out;
}

const SECRETISH = /(^|_)(KEY|TOKEN|SECRET)(_|$)/i;
const NOT_PROVIDER_KEYS = new Set(["ROUTER_KEY", "ADMIN_PASSWORD"]);

on("GET", /^\/admin\/env\/keys$/, (req, res) => {
  const c = getCfg();
  const attached = new Map<string, string>();
  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) attached.set(k, pn);
  const wanted = new URL(req.url ?? "/", "http://localhost").searchParams.get("provider") ?? "";
  const wantedBase = wanted.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const names = [...envNamesInFile()].filter((n) => SECRETISH.test(n) && !NOT_PROVIDER_KEYS.has(n));
  const keys = names.map((envName) => {
    const v = process.env[envName] ?? "";
    const suggested = Object.keys(c.providers).find((pn) => envName.startsWith(`${pn.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`)) ?? null;
    return {
      envName, configured: !!v, last4: v ? v.slice(-4) : "",
      attachedTo: attached.get(envName) ?? null, suggestedProvider: suggested,
    };
  });
  sendJSON(res, 200, {
    envVersion: envVersion(),
    keys: wanted ? keys.filter((k) => !k.attachedTo && (k.suggestedProvider === wanted || envNameMatches(k.envName, wantedBase))) : keys,
  });
});
const envNameMatches = (envName: string, base: string): boolean => !!base && envName.startsWith(`${base}_`);

on("POST", /^\/admin\/providers\/([^/]+)\/keys\/attach$/, async (req, res, [name]) => {
  const body = await readJSONBody(req);
  const c = getCfg();
  const p = c.providers[name];
  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
  const version = expectVersion(body);
  const list = Array.isArray(body.envNames) ? body.envNames : [];
  if (!list.length) throw new ValidationError([{ field: "envNames", message: "must be a non-empty list" }]);
  const inFile = envNamesInFile();
  const owner = new Map<string, string>();
  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) owner.set(k, pn);
  const errors: { field: string; message: string }[] = [];
  const add: string[] = [];
  list.forEach((raw: unknown, i: number) => {
    let n: string;
    try { n = validateEnvName(raw, `envNames.${i}`); } catch (e) { errors.push(...(e as ValidationError).errors); return; }
    if (!inFile.has(n)) errors.push({ field: `envNames.${i}`, message: `${n} is not defined in .env` });
    else if (owner.has(n) && owner.get(n) !== name) errors.push({ field: `envNames.${i}`, message: `${n} already belongs to provider "${owner.get(n)}"` });
    else if (!p.keys.includes(n) && !add.includes(n)) add.push(n);
  });
  if (errors.length) throw new ValidationError(errors);
  const next: Config = { ...c, providers: { ...c.providers, [name]: { ...p, keys: [...p.keys, ...add] } } };
  commit(next, version);
  sendJSON(res, 200, { version: configVersion(), attached: add, provider: providerView(name, getCfg().providers[name]) });
});

// ---------- request history + token insights ----------
const RANGE_MS: Record<string, number> = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3, all: 3650 * 86400e3 };

on("GET", /^\/admin\/requests$/, (req, res) => {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
  const status = q.get("status");
  const out = history.listRequests({
    limit: num("limit"), offset: num("offset"), before: num("before"),
    status: status === "ok" || status === "error" ? status : undefined,
    alias: q.get("alias") || undefined, provider: q.get("provider") || undefined,
    q: q.get("q") || undefined, minCtx: num("minCtx"),
  });
  sendJSON(res, 200, {
    ...out,
    running: [...inFlight.values()].map((f) => ({
      id: f.id, alias: f.alias, provider: f.provider, model: f.model, key: f.keyName, startedAt: f.startedAt,
      stream: f.stream, status: f.status, failover: !!f.failover, outSoFar: f.outSoFar ?? 0, tokensPerSec: f.tokensPerSec ?? null,
      askedAlias: f.askedAlias ?? null,
    })),
  });
});

on("POST", /^\/admin\/requests\/clear$/, (_req, res) => {
  sendJSON(res, 200, { deleted: history.clearAll() });
});

on("GET", /^\/admin\/insights$/, (req, res) => {
  const range = new URL(req.url ?? "/", "http://localhost").searchParams.get("range") ?? "24h";
  if (!(range in RANGE_MS)) throw new ValidationError([{ field: "range", message: `must be one of ${Object.keys(RANGE_MS).join(", ")}` }]);
  sendJSON(res, 200, { range, ...history.insights(RANGE_MS[range]) });
});

// ---------- app settings (SQLite) + system information ----------
on("GET", /^\/admin\/memory$/, (_req, res) => {
  sendJSON(res, 200, { summaries: listMemory(), stats: history.memoryStats(Date.now() - 86400e3) });
});
on("POST", /^\/admin\/memory\/clear$/, (_req, res) => {
  sendJSON(res, 200, { deleted: clearMemory() });
});
on("DELETE", /^\/admin\/memory\/([^/]+)$/, (_req, res, [session]) => {
  sendJSON(res, 200, { deleted: deleteMemory(decodeURIComponent(session)) });
});

on("GET", /^\/admin\/app-settings$/, (_req, res) => sendJSON(res, 200, { settings: allSettings() }));

on("PUT", /^\/admin\/app-settings$/, async (req, res) => {
  const body = await readJSONBody(req);
  const input = (body.settings ?? {}) as Record<string, unknown>;
  const errors: { field: string; message: string }[] = [];
  const clean: Record<string, unknown> = {};
  const int = (k: string, lo: number, hi: number) => {
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) errors.push({ field: k, message: `must be a whole number from ${lo} to ${hi}` });
    else clean[k] = n;
  };
  for (const k of Object.keys(input)) {
    if (!(k in SETTING_DEFAULTS)) { errors.push({ field: k, message: "unknown setting" }); continue; }
    if (k === "history.retentionDays") int(k, 0, 3650);
    else if (k === "context.warnTokens") int(k, 10_000, 2_000_000);
    else if (k === "pricing.peakMultiplier") {
      const n = Number(input[k]);
      if (!Number.isFinite(n) || n < 1 || n > 10) errors.push({ field: k, message: "must be a number from 1 to 10" }); else clean[k] = n;
    } else if (k === "guard.trimInputs" || k === "guard.trimPastes") {
      if (typeof input[k] !== "boolean") errors.push({ field: k, message: "must be true or false" });
      else clean[k] = input[k];
    } else if (k === "guard.pasteChars") int(k, 2_000, 200_000);
    else if (k === "memory.mode") {
      if (input[k] !== "off" && input[k] !== "shadow" && input[k] !== "on") errors.push({ field: k, message: "must be off, shadow or on" });
      else clean[k] = input[k];
    } else if (k === "memory.model") {
      const v = String(input[k] ?? "");
      if (v && !getCfg().models[v]) errors.push({ field: k, message: `"${v}" is not a known model` });
      else clean[k] = v;
    } else if (k === "memory.highTokens") int(k, 20_000, 2_000_000);
    else if (k === "memory.lowTokens") int(k, 5_000, 1_000_000);
    else if (k === "routing.failover") {
      if (input[k] !== "auto" && input[k] !== "off") errors.push({ field: k, message: "must be auto or off" });
      else clean[k] = input[k];
    } else if (k === "routing.retries") int(k, 0, 5);
    else if (k === "guard.mode") {
      if (input[k] !== "off" && input[k] !== "shadow" && input[k] !== "on") errors.push({ field: k, message: "must be off, shadow or on" });
      else clean[k] = input[k];
    } else if (k === "guard.highTokens") int(k, 20_000, 2_000_000);
    else if (k === "guard.lowTokens") int(k, 5_000, 1_000_000);
    else if (k === "guard.keepRecent") int(k, 1, 50);
    else if (k === "guard.minChars") int(k, 200, 100_000);
    else if (k === "ui.projectName") {
      const v = String(input[k] ?? "").trim();
      if (!v || v.length > 40) errors.push({ field: k, message: "must be 1-40 characters" }); else clean[k] = v;
    }
  }
  const cur = allSettings();
  const hi = Number(clean["guard.highTokens"] ?? cur["guard.highTokens"]);
  const lo = Number(clean["guard.lowTokens"] ?? cur["guard.lowTokens"]);
  if (("guard.highTokens" in clean || "guard.lowTokens" in clean) && lo >= hi) {
    errors.push({ field: "guard.lowTokens", message: "must be lower than guard.highTokens" });
  }
  const mhi = Number(clean["memory.highTokens"] ?? cur["memory.highTokens"]);
  const mlo = Number(clean["memory.lowTokens"] ?? cur["memory.lowTokens"]);
  if (("memory.highTokens" in clean || "memory.lowTokens" in clean) && mlo >= mhi) {
    errors.push({ field: "memory.lowTokens", message: "must be lower than memory.highTokens" });
  }
  if (("memory.mode" in clean || "memory.model" in clean) && (clean["memory.mode"] ?? cur["memory.mode"]) === "on" && !String(clean["memory.model"] ?? cur["memory.model"])) {
    errors.push({ field: "memory.model", message: "choose the model that writes the summaries before switching memory on" });
  }
  if (errors.length) throw new ValidationError(errors);
  for (const [k, v] of Object.entries(clean)) setSetting(k, v);
  if ("history.retentionDays" in clean) history.pruneOld();
  sendJSON(res, 200, { settings: allSettings() });
});

const startedAt = Date.now();
on("GET", /^\/admin\/system$/, (_req, res) => {
  const c = getCfg();
  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const oldest = db.prepare("SELECT MIN(ended_at) AS t FROM requests").get() as { t: number | null };
  let dbBytes = 0;
  try { dbBytes = fs.statSync(DB_FILE).size; } catch { /* not yet created */ }
  let logBytes = 0;
  try { logBytes = fs.statSync(LOG_FILE).size; } catch { /* no log yet */ }
  let version = "";
  try { version = JSON.parse(fs.readFileSync(path.join(process.env.ROUTER_HOME ?? path.resolve(__dirname, ".."), "package.json"), "utf8")).version; } catch { /* ignore */ }
  sendJSON(res, 200, {
    version, node: process.version, platform: `${process.platform}/${process.arch}`, pid: process.pid,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000), port: PORT,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    root: path.dirname(ROUTES_FILE),
    statusline: path.join(path.dirname(ROUTES_FILE), "scripts", "statusline.mjs"),
    paths: { routes: ROUTES_FILE, env: ENV_FILE, backups: BACKUP_DIR, database: DB_FILE, dataDir: DATA_DIR, usageLog: LOG_FILE },
    database: { bytes: dbBytes, requests: count("SELECT COUNT(*) AS n FROM requests"), oldestRequestAt: oldest.t, users: userCount() },
    usageLogBytes: logBytes,
    counts: { providers: Object.keys(c.providers).length, models: Object.keys(c.models).length },
    sseClients: sseClientCount(),
  });
});

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string
): Promise<boolean> {
  for (const [m, re, handler] of routes) {
    if (m !== method) continue;
    const match = re.exec(pathname);
    if (!match) continue;
    try {
      await handler(req, res, match.slice(1).map(decodeURIComponent));
      return true;
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendJSON(res, 400, {
          type: "error",
          error: { type: "validation_error", message: e.message },
          errors: e.errors,
        }), true;
      }
      if (e instanceof StaleVersionError) {
        return sendJSON(res, 409, {
          type: "error",
          error: { type: "conflict_error", message: "Config changed on disk since you loaded it." },
          currentVersion: e.current,
        }), true;
      }
      console.error("[ADMIN]", e);
      fail(res, 500, "api_error", e instanceof Error ? e.message : String(e));
      return true;
    }
  }
  return false;
}

export { MAX_SSE_CLIENTS };
