import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";

import { Config, ModelCfg, PORT, ProviderCfg, ROOT, ROUTER_KEY, getCfg } from "./config";
import { handleAdmin, hostAllowed, originAllowed } from "./admin";
import * as eta from "./eta";
import * as live from "./live";
import { buildBody, buildHeaders, keyOrder, resolveAlias } from "./routing";

if (!ROUTER_KEY) {
  console.error("ROUTER_KEY is missing in .env - refusing to start without auth.");
  process.exit(1);
}

// ---------- state ----------
interface UsageTotals { in: number; out: number; cacheRead: number; cacheWrite: number }
const ZERO = (): UsageTotals => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
const totals = new Map<string, UsageTotals & { requests: number; cost: number }>();
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

function mergeUsage(u: UsageTotals, x: any): void {
  if (!x || typeof x !== "object") return;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  u.in = Math.max(u.in, n(x.input_tokens));
  u.out = Math.max(u.out, n(x.output_tokens));
  u.cacheRead = Math.max(u.cacheRead, n(x.cache_read_input_tokens));
  u.cacheWrite = Math.max(u.cacheWrite, n(x.cache_creation_input_tokens));
}

// Live output estimate. Standard Anthropic streams carry usage only in
// message_start / the trailing message_delta, so outSoFar would stay pinned and
// the live tokens/sec would never engage. Content deltas are counted and
// converted at ~4 chars/token until real usage arrives; mergeUsage keeps the
// max, so the authoritative final usage always wins for the log.
function sniffSSE(event: string, u: UsageTotals, est: { chars: number }): void {
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const d = JSON.parse(line.slice(5).trim());
      if (d.type === "message_start") mergeUsage(u, d.message?.usage);
      else if (d.type === "message_delta") mergeUsage(u, d.usage);
      else if (d.type === "content_block_delta") {
        const t = d.delta?.text ?? d.delta?.thinking ?? d.delta?.partial_json ?? "";
        if (typeof t === "string") est.chars += t.length;
      }
    } catch {
      /* ignore partial / non-JSON */
    }
  }
}

// Timing fields for the usage log (all optional; old lines keep the old shape).
interface Timing {
  sessionId?: string | null;
  startedAt?: number;
  firstTokenAt?: number | null;
  ttftMs?: number | null;
  durationMs?: number;
  outputTokensPerSec?: number | null;
  // History-ring gating only (never logged): only streaming samples carry a
  // real ttft/tps, and a mid-stream abort is not a successful request.
  streamed?: boolean;
  aborted?: boolean;
}

function record(
  alias: string, m: ModelCfg, keyName: string, u: UsageTotals, status: number, ms: number, timing?: Timing
): void {
  const p = m.price;
  const cost = p ? (u.in * p.in + u.out * p.out + u.cacheRead * (p.cacheRead ?? p.in)) / 1e6 : 0;
  const t = totals.get(alias) ?? { ...ZERO(), requests: 0, cost: 0 };
  t.requests++; t.in += u.in; t.out += u.out; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; t.cost += cost;
  totals.set(alias, t);
  const line = {
    ts: new Date().toISOString(), alias, provider: m.provider, model: m.model, key: keyName, status, ms, ...u, cost,
    sessionId: timing?.sessionId ?? null,
    startedAt: timing?.startedAt ? new Date(timing.startedAt).toISOString() : null,
    firstTokenAt: timing?.firstTokenAt ? new Date(timing.firstTokenAt).toISOString() : null,
    durationMs: timing?.durationMs ?? ms,
    ttftMs: timing?.ttftMs ?? null,
    outputTokensPerSec: timing?.outputTokensPerSec ?? null,
  };
  try {
    fs.appendFileSync(path.join(ROOT, "logs", "usage.jsonl"), JSON.stringify(line) + "\n");
    eta.feedHistory(m.provider, m.model, {
      status, out: u.out,
      // Rings hold streaming successes only: non-streaming ttft/tps are
      // full-duration shapes and an aborted stream is not a completed request.
      ttftMs: timing?.streamed && !timing?.aborted ? timing?.ttftMs ?? null : null,
      outputTokensPerSec: timing?.streamed && !timing?.aborted ? timing?.outputTokensPerSec ?? null : null,
      aborted: timing?.aborted,
    });
    eta.sessionBump({
      sessionId: timing?.sessionId ?? null, provider: m.provider, model: m.model,
      in: u.in, out: u.out, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost, ms, status, ts: Date.now(),
    });
  } catch { /* ignore */ }
  console.log(
    `[USAGE] ${alias} via ${keyName} ${status} ${ms}ms in=${u.in} out=${u.out} cacheR=${u.cacheRead} cacheW=${u.cacheWrite}`
  );
}

// ---------- main proxy ----------
async function relay(
  up: Response, res: ServerResponse, body: Record<string, unknown>,
  alias: string, m: ModelCfg, keyName: string, started: number, track?: live.InFlight
): Promise<void> {
  const u = ZERO();
  res.statusCode = up.status;
  const ct = up.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  res.setHeader("x-router-route", `${m.provider}/${m.model}`);

  const streamed = !!(body.stream && up.body);
  let firstTokenAt = 0;
  let aborted = false;
  try {
    if (streamed) {
      res.setHeader("cache-control", "no-cache");
      res.flushHeaders();
      live.markStreaming(track?.id ?? "");
      const dec = new TextDecoder();
      let buf = "";
      const est = { chars: 0 };
      try {
        for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
            eta.firstToken(track?.id ?? "");
          }
          if (!res.write(chunk)) {
            // A client that vanished under backpressure never drains: race the
            // close so the relay cannot hang here forever.
            await Promise.race([once(res, "drain"), once(res, "close")]);
            if (res.destroyed || res.writableEnded) throw new Error("client disconnected mid-stream");
          }
          buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            sniffSSE(buf.slice(0, i), u, est);
            eta.noteOutput(track?.id ?? "", Math.max(u.out, Math.round(est.chars / 4)));
            buf = buf.slice(i + 2);
          }
        }
      } catch (e) {
        aborted = true;
        eta.markError(track?.id ?? "");
        if (!res.writableEnded) console.warn("[ROUTER] stream interrupted:", (e as Error).message);
      }
      res.end();
    } else {
      const text = await up.text();
      firstTokenAt = Date.now();
      try { mergeUsage(u, JSON.parse(text).usage); } catch { /* not JSON */ }
      res.end(text);
    }
    const endedAt = Date.now();
    const durationMs = endedAt - started;
    // Streaming has a real TTFT; without a stream the client-observed truth is that
    // the whole body arrived at once (firstTokenAt === endedAt, ttftMs === durationMs).
    const ttftMs = streamed ? (firstTokenAt ? firstTokenAt - started : null) : durationMs > 0 ? durationMs : null;
    const outputTokensPerSec = u.out > 0 && durationMs > 0
      ? Math.round(
          (u.out / (streamed && firstTokenAt && endedAt > firstTokenAt
            ? (endedAt - firstTokenAt) / 1000
            : durationMs / 1000)) * 100
        ) / 100
      : null;
    const timing: Timing = {
      sessionId: track?.sessionId ?? null,
      startedAt: started,
      firstTokenAt: streamed ? (firstTokenAt || null) : endedAt,
      ttftMs,
      durationMs,
      outputTokensPerSec,
      streamed,
      aborted,
    };
    record(alias, m, keyName, u, up.status, durationMs, timing);
    if (track) {
      live.finishRequest(track.id, {
        alias, provider: m.provider, model: m.model, key: keyName, status: up.status,
        ms: durationMs, ...u, cost: costOf(m, u),
        sessionId: track.sessionId ?? null, startedAt: started,
        firstTokenAt: timing.firstTokenAt, ttftMs, durationMs, outputTokensPerSec,
      });
    }
  } finally {
    // A relay that throws (e.g. the upstream body died mid-read) must still
    // release the in-flight entry, or the eta ticker broadcasts a phantom run.
    if (track && live.inFlight.has(track.id)) {
      live.finishRequest(track.id, {
        alias, provider: m.provider, model: m.model, key: keyName, status: 502,
        ms: Date.now() - started, ...ZERO(), cost: 0,
        sessionId: track.sessionId ?? null, startedAt: started,
      });
    }
  }
}

function costOf(m: ModelCfg, u: UsageTotals): number {
  const p = m.price;
  if (!p) return 0;
  return (u.in * p.in + u.out * p.out + u.cacheRead * (p.cacheRead ?? p.in)) / 1e6;
}

async function proxyMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return fail(res, 400, "invalid_request_error", "Body is not valid JSON"); }
  if (typeof body.model !== "string" || !body.model) {
    return fail(res, 400, "invalid_request_error", "model is required");
  }

  const c: Config = getCfg();
  const alias = resolveAlias(c, body.model);
  if (!alias) {
    return fail(res, 400, "invalid_request_error",
      `Unknown model "${body.model}". Available: ${Object.keys(c.models).join(", ")}`);
  }

  const meta = body.metadata as { user_id?: string } | undefined;
  const seed = String(meta?.user_id ?? JSON.stringify(body.system ?? "").slice(0, 4000));
  const sessionId = "u-" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
  const chain = [alias, ...(c.models[alias].fallback ?? [])].filter((n) => c.models[n]);

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  let lastStatus = 503;
  let lastText = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: "No usable upstream key (missing or cooling down)" },
  });

  // One tracked request for the whole chain: failovers keep the same requestId
  // and the terminal eta event is emitted exactly once, after the last route.
  let track: live.InFlight | undefined;

  for (const routeName of chain) {
    const m = c.models[routeName];
    const p: ProviderCfg | undefined = c.providers[m.provider];
    if (!p || p.disabled) {
      if (p?.disabled) console.warn(`[ROUTER] provider ${m.provider} is disabled, skipping`);
      continue;
    }

    for (const keyName of keyOrder(p, m, seed)) {
      if ((live.cooldown.get(keyName) ?? 0) > Date.now()) continue;

      console.log(`[ROUTER] ${body.model} -> ${routeName} (${m.provider}/${m.model}) key=${keyName}`);
      if (!track) {
        track = live.startRequest({
          alias: routeName,
          provider: m.provider,
          model: m.model,
          keyName,
          startedAt: Date.now(),
          stream: !!body.stream,
          status: "connecting",
          sessionId,
          maxTokens: Number(body.max_tokens) || 0,
          clientStartedAt: started,
        });
        eta.begin(track);
      } else if (track.alias !== routeName || track.keyName !== keyName) {
        // Same logical request on a new route/key: keep the live frames accurate.
        track.alias = routeName;
        track.provider = m.provider;
        track.model = m.model;
        track.keyName = keyName;
      }

      let up: Response;
      try {
        up = await fetch(`${p.baseURL}/v1/messages`, {
          method: "POST",
          headers: buildHeaders(req, p, keyName),
          body: buildBody(body, m, p),
          signal: ac.signal,
        });
      } catch (e) {
        if (ac.signal.aborted) {
          live.finishRequest(track.id, {
            alias: routeName, provider: m.provider, model: m.model, key: keyName, status: 499,
            ms: Date.now() - started, ...ZERO(), cost: 0, sessionId,
          });
          return;
        }
        live.cool(keyName, 15_000);
        live.setFailover(track.id, { from: keyName, status: 0, reason: `unreachable: ${(e as Error).message}` });
        lastStatus = 502;
        lastText = JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream unreachable: ${(e as Error).message}` } });
        continue;
      }

      if ([401, 402, 403, 429].includes(up.status) || up.status >= 500) {
        const retryAfter = Number(up.headers.get("retry-after")) * 1000;
        const ms = up.status === 429 ? Math.min(retryAfter || 60_000, 300_000)
          : up.status >= 500 ? 15_000 : 600_000;
        live.cool(keyName, ms);
        lastStatus = up.status;
        try { lastText = await up.text(); } catch { /* error body unreadable -> keep the last one */ }
        live.setFailover(track.id, { from: keyName, status: up.status, reason: `${up.status} on ${keyName}` });
        console.warn(`[ROUTER] ${keyName} -> ${up.status}, cooling ${Math.round(ms / 1000)}s, trying next`);
        continue;
      }

      return relay(up, res, body, routeName, m, keyName, started, track);
    }
  }

  // The whole chain failed: close the tracked request exactly once, after every
  // route had its chance (failover successes never reach this terminal frame).
  if (track && live.inFlight.has(track.id)) {
    live.finishRequest(track.id, {
      alias: track.alias, provider: track.provider, model: track.model, key: track.keyName, status: lastStatus,
      ms: Date.now() - started, ...ZERO(), cost: 0, sessionId,
    });
  }

  res.writeHead(lastStatus, { "content-type": "application/json" });
  res.end(lastText);
}

// ---------- UI ----------
const UI_CANDIDATES = [
  path.join(__dirname, "ui", "index.html"),       // dist/ui/index.html (after npm run build)
  path.join(ROOT, "src", "ui", "index.html"),    // source fallback
];

function uiFile(): string | undefined {
  return UI_CANDIDATES.find((f) => fs.existsSync(f));
}

function serveUI(res: ServerResponse): void {
  const file = uiFile();
  if (!file) return fail(res, 404, "not_found_error", "UI not built. Run: npm run build");
  const html = fs.readFileSync(file, "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
  });
  res.end(html);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && p === "/health") return sendJSON(res, 200, { status: "ok" });

    // UI shell: no secrets inside it, so it loads before the key prompt.
    if (req.method === "GET" && (p === "/ui" || p === "/ui/index.html")) {
      if (!hostAllowed(req)) return fail(res, 403, "forbidden_error", "Host header not allowed");
      return serveUI(res);
    }

    if (!authed(req)) return fail(res, 401, "authentication_error", "Invalid router key");
    if (!hostAllowed(req)) return fail(res, 403, "forbidden_error", "Host header not allowed");
    const stateChanging = req.method !== "GET" && req.method !== "HEAD";
    if (stateChanging && !originAllowed(req)) {
      return fail(res, 403, "forbidden_error", "Cross-origin request refused");
    }

    if (p === "/admin/status") {
      const c = getCfg();
      return sendJSON(res, 200, {
        providers: Object.fromEntries(Object.entries(c.providers).map(([n, pr]) => [n, pr.keys.map((k) => ({
          key: k, configured: !!process.env[k],
          coolingSeconds: Math.max(0, Math.round(((live.cooldown.get(k) ?? 0) - Date.now()) / 1000)),
        }))])),
        models: c.models,
      });
    }

    if (p === "/admin/usage") {
      return sendJSON(res, 200, Object.fromEntries(totals));
    }

    if (p === "/admin" || p.startsWith("/admin/")) {
      const handled = await handleAdmin(req, res, p, req.method ?? "GET");
      if (!handled) fail(res, 404, "not_found_error", "Unknown admin endpoint");
      return;
    }

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
          coolingSeconds: Math.max(0, Math.round(((live.cooldown.get(k) ?? 0) - Date.now()) / 1000)),
        }))])),
        models: c.models,
      });
    }

    if (req.method === "GET" && p === "/admin/usage") {
      return sendJSON(res, 200, Object.fromEntries(totals));
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
// The rings are seeded before the port opens: a request in the first moments
// after restart must not get etaMs=null ("estimating...") against a populated
// usage log. An unreadable log degrades to empty history, not a crash.
eta.seedHistory()
  .catch((e) => console.warn("[ETA] usage log unreadable -> seeding with empty history:",
    e instanceof Error ? e.message : String(e)))
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      const c = getCfg();
      console.log(`\nClaude Router v2  ->  http://127.0.0.1:${PORT}\n${"-".repeat(40)}`);
      for (const [name, m] of Object.entries(c.models)) {
        const p = c.providers[m.provider];
        const ok = !p ? "NO PROVIDER" : p.disabled ? "DISABLED" : keyOrder(p, m, "x").length ? "ok" : "NO KEY";
        console.log(`  ${name.padEnd(10)} ${m.provider}/${m.model}  [${ok}]`);
      }
      console.log(`\n  UI (needs ROUTER_KEY):  http://127.0.0.1:${PORT}/ui\n`);
    });
  });
