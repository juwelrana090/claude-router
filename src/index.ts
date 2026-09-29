import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";

const ROOT = process.env.ROUTER_HOME ?? path.resolve(__dirname, "..");

// ---------- .env (must run BEFORE reading any process.env constant) ----------
function loadEnv(): void {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    // strip inline comment (only when preceded by whitespace) and surrounding quotes
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "");
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.ROUTER_PORT || 21450);
const ROUTER_KEY = process.env.ROUTER_KEY || "";
if (!ROUTER_KEY) {
  console.error("ROUTER_KEY is missing in .env - refusing to start without auth.");
  process.exit(1);
}

// ---------- config (routes.json, hot-reloaded) ----------
type AuthMode = "bearer" | "x-api-key" | "both";

interface ProviderCfg {
  baseURL: string;
  auth: AuthMode;
  keys: string[]; // env var NAMES, not the secrets
  dropBeta?: boolean;
  dropBodyFields?: string[];
}

interface ModelCfg {
  provider: string;
  model: string;
  key?: string; // pin this model to one specific key (env var name)
  maxOutputTokens?: number;
  fallback?: string[]; // other router model names, tried in order
  price?: { in: number; out: number; cacheRead?: number }; // USD per 1M tokens
}

interface Config {
  defaultModel?: string;
  aliases?: Record<string, string>;
  providers: Record<string, ProviderCfg>;
  models: Record<string, ModelCfg>;
}

const ROUTES_FILE = path.join(ROOT, process.env.ROUTES_FILE ?? "routes.json");
let cfg: Config | undefined;
let cfgMtime = 0;

function getCfg(): Config {
  try {
    const m = fs.statSync(ROUTES_FILE).mtimeMs;
    if (!cfg || m !== cfgMtime) {
      cfg = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8")) as Config;
      cfgMtime = m;
      if (cfg) console.log(`[ROUTER] routes loaded (${Object.keys(cfg.models).length} models)`);
    }
  } catch (e) {
    if (!cfg) throw e;
    console.warn("[ROUTER] routes.json invalid, keeping previous config:", (e as Error).message);
  }
  return cfg as Config;
}

// ---------- state ----------
const cooldown = new Map<string, number>(); // key env name -> epoch ms
interface Usage { in: number; out: number; cacheRead: number; cacheWrite: number }
const zero = (): Usage => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
const totals = new Map<string, Usage & { requests: number; cost: number }>();
fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });

// ---------- helpers ----------
function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function fail(res: ServerResponse, status: number, type: string, message: string): void {
  sendJSON(res, status, { type: "error", error: { type, message } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authed(req: IncomingMessage): boolean {
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const xk = String(req.headers["x-api-key"] ?? "");
  return safeEq(bearer, ROUTER_KEY) || safeEq(xk, ROUTER_KEY);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(",") : v;
}

function resolveAlias(c: Config, raw: string): string | undefined {
  const name = raw.replace(/\[[^\]]*\]$/, "").trim(); // "sonnet[1m]" -> "sonnet"
  if (c.models[name]) return name;
  const lower = name.toLowerCase();
  for (const [needle, target] of Object.entries(c.aliases ?? {})) {
    if (lower.includes(needle) && c.models[target]) return target;
  }
  if (c.defaultModel && c.models[c.defaultModel]) {
    console.warn(`[ROUTER] unknown model "${raw}" -> default "${c.defaultModel}"`);
    return c.defaultModel;
  }
  return undefined;
}

// Sticky key choice keeps the provider-side prompt cache warm (cache is per account/key).
function keyOrder(p: ProviderCfg, m: ModelCfg, seed: string): string[] {
  if (m.key) return process.env[m.key] ? [m.key] : [];
  const names = p.keys.filter((k) => process.env[k]);
  if (!names.length) return [];
  const start = crypto.createHash("sha1").update(seed).digest().readUInt32BE(0) % names.length;
  return names.map((_, i) => names[(start + i) % names.length]);
}

function cool(key: string, ms: number): void {
  cooldown.set(key, Date.now() + ms);
}

function buildHeaders(req: IncomingMessage, p: ProviderCfg, keyName: string): Record<string, string> {
  const key = process.env[keyName] as string;
  const h: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": headerValue(req.headers["anthropic-version"]) || "2023-06-01",
  };
  if (p.auth === "bearer" || p.auth === "both") h["authorization"] = `Bearer ${key}`;
  if (p.auth === "x-api-key" || p.auth === "both") h["x-api-key"] = key;
  const beta = headerValue(req.headers["anthropic-beta"]);
  if (beta && !p.dropBeta) h["anthropic-beta"] = beta;
  return h;
}

function buildBody(body: Record<string, unknown>, m: ModelCfg, p: ProviderCfg): string {
  const out: Record<string, unknown> = { ...body, model: m.model };
  for (const f of p.dropBodyFields ?? []) delete out[f];
  if (m.maxOutputTokens && typeof out.max_tokens === "number" && out.max_tokens > m.maxOutputTokens) {
    out.max_tokens = m.maxOutputTokens; // clamp DOWN only
  }
  return JSON.stringify(out);
}

function mergeUsage(u: Usage, x: any): void {
  if (!x || typeof x !== "object") return;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  u.in = Math.max(u.in, n(x.input_tokens));
  u.out = Math.max(u.out, n(x.output_tokens));
  u.cacheRead = Math.max(u.cacheRead, n(x.cache_read_input_tokens));
  u.cacheWrite = Math.max(u.cacheWrite, n(x.cache_creation_input_tokens));
}

function sniffSSE(event: string, u: Usage): void {
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const d = JSON.parse(line.slice(5).trim());
      if (d.type === "message_start") mergeUsage(u, d.message?.usage);
      else if (d.type === "message_delta") mergeUsage(u, d.usage);
    } catch {
      /* ignore partial / non-JSON */
    }
  }
}

function record(
  alias: string, m: ModelCfg, keyName: string, u: Usage, status: number, ms: number
): void {
  const p = m.price;
  const cost = p ? (u.in * p.in + u.out * p.out + u.cacheRead * (p.cacheRead ?? p.in)) / 1e6 : 0;
  const t = totals.get(alias) ?? { ...zero(), requests: 0, cost: 0 };
  t.requests++; t.in += u.in; t.out += u.out; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; t.cost += cost;
  totals.set(alias, t);
  const line = { ts: new Date().toISOString(), alias, provider: m.provider, model: m.model, key: keyName, status, ms, ...u, cost };
  try { fs.appendFileSync(path.join(ROOT, "logs", "usage.jsonl"), JSON.stringify(line) + "\n"); } catch { /* ignore */ }
  console.log(
    `[USAGE] ${alias} via ${keyName} ${status} ${ms}ms in=${u.in} out=${u.out} cacheR=${u.cacheRead} cacheW=${u.cacheWrite}`
  );
}

// ---------- main proxy ----------
async function relay(
  up: Response, res: ServerResponse, body: Record<string, unknown>,
  alias: string, m: ModelCfg, keyName: string, started: number
): Promise<void> {
  const u = zero();
  res.statusCode = up.status;
  const ct = up.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  res.setHeader("x-router-route", `${m.provider}/${m.model}`);

  if (body.stream && up.body) {
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
        if (!res.write(chunk)) await once(res, "drain");
        buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          sniffSSE(buf.slice(0, i), u);
          buf = buf.slice(i + 2);
        }
      }
    } catch (e) {
      if (!res.writableEnded) console.warn("[ROUTER] stream interrupted:", (e as Error).message);
    }
    res.end();
  } else {
    const text = await up.text();
    try { mergeUsage(u, JSON.parse(text).usage); } catch { /* not JSON */ }
    res.end(text);
  }
  record(alias, m, keyName, u, up.status, Date.now() - started);
}

async function proxyMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return fail(res, 400, "invalid_request_error", "Body is not valid JSON"); }
  if (typeof body.model !== "string" || !body.model) {
    return fail(res, 400, "invalid_request_error", "model is required");
  }

  const c = getCfg();
  const alias = resolveAlias(c, body.model);
  if (!alias) {
    return fail(res, 400, "invalid_request_error",
      `Unknown model "${body.model}". Available: ${Object.keys(c.models).join(", ")}`);
  }

  const meta = body.metadata as { user_id?: string } | undefined;
  const seed = String(meta?.user_id ?? JSON.stringify(body.system ?? "").slice(0, 4000));
  const chain = [alias, ...(c.models[alias].fallback ?? [])].filter((n) => c.models[n]);

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  let lastStatus = 503;
  let lastText = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: "No usable upstream key (missing or cooling down)" },
  });

  for (const routeName of chain) {
    const m = c.models[routeName];
    const p = c.providers[m.provider];
    if (!p) continue;

    for (const keyName of keyOrder(p, m, seed)) {
      if ((cooldown.get(keyName) ?? 0) > Date.now()) continue;

      console.log(`[ROUTER] ${body.model} -> ${routeName} (${m.provider}/${m.model}) key=${keyName}`);
      let up: Response;
      try {
        up = await fetch(`${p.baseURL}/v1/messages`, {
          method: "POST",
          headers: buildHeaders(req, p, keyName),
          body: buildBody(body, m, p),
          signal: ac.signal,
        });
      } catch (e) {
        if (ac.signal.aborted) return;
        cool(keyName, 15_000);
        lastStatus = 502;
        lastText = JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream unreachable: ${(e as Error).message}` } });
        continue;
      }

      if ([401, 402, 403, 429].includes(up.status) || up.status >= 500) {
        const retryAfter = Number(up.headers.get("retry-after")) * 1000;
        const ms = up.status === 429 ? Math.min(retryAfter || 60_000, 300_000)
          : up.status >= 500 ? 15_000 : 600_000;
        cool(keyName, ms);
        lastStatus = up.status;
        lastText = await up.text();
        console.warn(`[ROUTER] ${keyName} -> ${up.status}, cooling ${Math.round(ms / 1000)}s, trying next`);
        continue;
      }

      return relay(up, res, body, routeName, m, keyName, started);
    }
  }

  res.writeHead(lastStatus, { "content-type": "application/json" });
  res.end(lastText);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && p === "/health") return sendJSON(res, 200, { status: "ok" });
    if (!authed(req)) return fail(res, 401, "authentication_error", "Invalid router key");

    // Claude Code calls /v1/messages?beta=true - match on pathname, not the raw URL.
    if (req.method === "POST" && (p === "/v1/messages" || p === "/messages")) {
      return await proxyMessages(req, res);
    }

    // Local token estimate: no upstream call, no cost, no 404 noise.
    if (req.method === "POST" && p === "/v1/messages/count_tokens") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const chars = JSON.stringify([b.system ?? "", b.messages ?? [], b.tools ?? []]).length;
      return sendJSON(res, 200, { input_tokens: Math.ceil(chars / 3.5) });
    }

    if (req.method === "GET" && p === "/v1/models") {
      const c = getCfg();
      return sendJSON(res, 200, {
        data: Object.keys(c.models).map((id) => ({ type: "model", id, display_name: id, created_at: "2025-01-01T00:00:00Z" })),
        has_more: false,
      });
    }

    if (req.method === "GET" && p === "/admin/status") {
      const c = getCfg();
      return sendJSON(res, 200, {
        providers: Object.fromEntries(Object.entries(c.providers).map(([n, pr]) => [n, pr.keys.map((k) => ({
          key: k, configured: !!process.env[k],
          coolingSeconds: Math.max(0, Math.round(((cooldown.get(k) ?? 0) - Date.now()) / 1000)),
        }))])),
        models: c.models,
      });
    }

    if (req.method === "GET" && p === "/admin/usage") {
      return sendJSON(res, 200, Object.fromEntries(totals));
    }

    fail(res, 404, "not_found_error", "Not found");
  } catch (e) {
    console.error(e);
    fail(res, 500, "api_error", e instanceof Error ? e.message : String(e));
  }
});

server.requestTimeout = 0; // long streaming responses must not be cut
server.listen(PORT, "127.0.0.1", () => {
  const c = getCfg();
  console.log(`\nClaude Router v2  ->  http://127.0.0.1:${PORT}\n${"-".repeat(40)}`);
  for (const [name, m] of Object.entries(c.models)) {
    const p = c.providers[m.provider];
    const ok = !p ? "NO PROVIDER" : keyOrder(p, m, "x").length ? "ok" : "NO KEY";
    console.log(`  ${name.padEnd(10)} ${m.provider}/${m.model}  [${ok}]`);
  }
  console.log("");
});
