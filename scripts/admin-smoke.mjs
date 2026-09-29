// Admin/UI smoke test: fully offline, mock upstreams only.
// Run: npm run smoke:admin   (builds first)
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-admin-"));
const PORT = 21998;
const R = `http://127.0.0.1:${PORT}`;
const ROUTER_KEY = "test-router-key";
const FAKE_KEY = "K-SUPER-SECRET-VALUE-9999";
const RATELIMIT_KEY = "K-RATELIMIT-VALUE-5678";
const DEAD_KEY = "K-DEAD-VALUE-1111";
const FAKE_KEY2 = "K-GOOD-VALUE-1234";

// Every request the mock upstream ever sees. Proves the UI costs zero tokens.
let upstreamHits = [];
let streamGate = null; // holds the streaming response open until released

const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const body = JSON.parse(data || "{}");
    const key = req.headers["x-api-key"] || String(req.headers.authorization || "").replace("Bearer ", "");
    upstreamHits.push({ url: req.url, key, model: body.model, max_tokens: body.max_tokens });
    if (body.stream && streamGate) return streamGate(res);
    if (key === RATELIMIT_KEY) { res.writeHead(429, { "retry-after": "30" }); return res.end('{"error":"rl"}'); }
    if (key === DEAD_KEY) { res.writeHead(500); return res.end('{"error":"boom"}'); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7 },
    }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

const routesFile = path.join(home, "routes.json");
const envFile = path.join(home, ".env");
const backupDir = path.join(home, "backups");

fs.writeFileSync(routesFile, JSON.stringify({
  defaultModel: "a",
  aliases: { sonnet: "a" },
  providers: { p1: { baseURL: base, auth: "bearer", keys: ["P1_K1", "P1_K2"] } },
  models: {
    a: { provider: "p1", model: "real-a", maxOutputTokens: 1000, fallback: ["b"] },
    b: { provider: "p1", model: "real-b" },
  },
}, null, 2) + "\n");
fs.writeFileSync(envFile, `ROUTER_PORT=${PORT}\nROUTER_KEY="${ROUTER_KEY}"\nP1_K1=${RATELIMIT_KEY}\nP1_K2=${FAKE_KEY2}\n`);

const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
// A router left over from a previous crashed run would silently answer these
// requests from stale code, so fail loudly instead of testing the wrong process.
let spawnFailure;
child.on("exit", (code) => { spawnFailure = `router exited early (code ${code}):\n${log}`; });
await new Promise((r) => setTimeout(r, 900));
if (spawnFailure) {
  console.error(spawnFailure);
  process.exit(1);
}
process.on("exit", () => child.kill());

let fails = 0;
const t = (name, ok, extra) => {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || extra === undefined ? "" : `  -> ${JSON.stringify(extra)}`));
  if (!ok) fails++;
};
const eq = (name, a, b) => t(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const H = { "content-type": "application/json", "x-api-key": ROUTER_KEY };
const call = (method, p, body, headers = H) =>
  fetch(R + p, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// fetch() refuses to set Host, so the Host-guard tests go through node:http.
const raw = (method, p, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, text: b }));
    });
    req.on("error", reject);
    req.end();
  });

const snapshot = () => fetch(R + "/admin/snapshot", { headers: H }).then((r) => r.json());
const version = async () => (await snapshot()).version;
const routes = () => JSON.parse(fs.readFileSync(routesFile, "utf8"));
const envText = () => fs.readFileSync(envFile, "utf8");
const del = (p) => ({ ...H, "x-config-version": undefined, "x-config-version": null });
const withVersion = async () => ({ ...H, "x-config-version": await version() });

// ───────────────────────── 1. auth + host + origin ─────────────────────────
t("401 without router key", (await fetch(R + "/admin/snapshot")).status === 401);
t("401 with wrong router key", (await fetch(R + "/admin/snapshot", { headers: { "x-api-key": "nope" } })).status === 401);
t("401 on POST /admin/providers without key", (await fetch(R + "/admin/providers", { method: "POST" })).status === 401);
t("401 on DELETE without key", (await fetch(R + "/admin/models/a", { method: "DELETE" })).status === 401);

{
  const r = await raw("GET", "/admin/snapshot", { "x-api-key": ROUTER_KEY, host: "evil.example.com" });
  t("403 on foreign Host header", r.status === 403, r);
  t("403 on foreign Host for the UI shell too", (await raw("GET", "/ui", { host: "evil.example.com" })).status === 403);
  t("127.0.0.1:<port> Host allowed", (await raw("GET", "/admin/snapshot", { "x-api-key": ROUTER_KEY, host: `127.0.0.1:${PORT}` })).status === 200);
  t("localhost:<port> Host allowed", (await raw("GET", "/admin/snapshot", { "x-api-key": ROUTER_KEY, host: `localhost:${PORT}` })).status === 200);
  t("no CORS headers anywhere", !(await raw("GET", "/admin/snapshot", { "x-api-key": ROUTER_KEY, host: `127.0.0.1:${PORT}` })).text.includes("Access-Control"));
}

{
  const foreign = { ...H, origin: "http://evil.example.com" };
  t("403 on foreign Origin for POST", (await call("POST", "/admin/providers", { name: "x", baseURL: base }, foreign)).status === 403);
  t("403 on foreign Origin for PUT", (await call("PUT", "/admin/models/c", { model: "x", version: await version() }, foreign)).status === 403);
  t("403 on foreign Origin for DELETE", (await call("DELETE", "/admin/models/a", undefined, foreign)).status === 403);

  const good = { ...H, origin: `http://127.0.0.1:${PORT}` };
  const r = await call("POST", "/admin/providers", { name: "tmp-origin", baseURL: base, version: await version() }, good);
  const body = await r.text();
  t("same-origin Origin allowed", r.status === 201, { status: r.status, body });
  await call("DELETE", "/admin/providers/tmp-origin", undefined, await withVersion());
}

{
  const r = await fetch(R + "/ui");
  const html = await r.text();
  t("UI shell served without key", r.status === 200);
  t("UI loads no external resources",
    !/<script[^>]+\bsrc=/i.test(html) && !/<link[^>]+stylesheet/i.test(html) &&
    !/@import/i.test(html) && !/fetch\(\s*["'`]https?:/i.test(html) && !/<img/i.test(html));
  t("UI sets a restrictive CSP", /default-src 'none'/.test(r.headers.get("content-security-policy") || ""));
  t("UI keeps the key out of the markup", !html.includes(ROUTER_KEY));
}

// ───────────────────────── 2. zero cost: GETs never touch upstream ─────────────────────────
upstreamHits = [];
for (const p of ["/admin/snapshot", "/admin/providers", "/admin/models", "/admin/settings", "/admin/status",
                 "/admin/usage", "/admin/usage/summary?range=24h", "/admin/providers/p1", "/admin/models/a",
                 "/v1/models"]) {
  await fetch(R + p, { headers: H });
}
{
  // opening SSE must not cause a single upstream call
  const ac = new AbortController();
  const es = await fetch(R + "/admin/events", { headers: { ...H, accept: "text/event-stream" }, signal: ac.signal });
  const reader = es.body.getReader();
  await reader.read();
  await new Promise((r) => setTimeout(r, 1200));
  ac.abort();
}
eq("no upstream call from any GET or from opening SSE", upstreamHits.length, 0);

// ───────────────────────── 3. provider CRUD round trip ─────────────────────────
{
  const v = await version();
  let r = await call("POST", "/admin/providers", { name: "Bad Name", baseURL: base, version: v });
  let body = await r.json();
  eq("invalid provider name -> 400", r.status, 400);
  t("per-field error message returned", body.errors?.[0]?.field === "name", body);

  r = await call("POST", "/admin/providers", { name: "p2", baseURL: "http://insecure.example.com", version: v });
  body = await r.json();
  t("http baseURL rejected for non-localhost", r.status === 400 && /https/.test(body.errors[0].message), body);

  r = await call("POST", "/admin/providers", { name: "p2", baseURL: "not a url", version: v });
  t("malformed baseURL rejected", r.status === 400);

  r = await call("POST", "/admin/providers", { name: "localp", baseURL: "http://localhost:9999", version: v });
  t("http baseURL allowed for localhost", r.status === 201, await r.text());

  r = await call("POST", "/admin/providers", { name: "p2", baseURL: base, auth: "weird", version: await version() });
  eq("bad auth mode -> 400", r.status, 400);

  r = await call("POST", "/admin/providers", { name: "p2", baseURL: base, version: await version() });
  eq("provider created", r.status, 201, await r.text());

  r = await call("POST", "/admin/providers", { name: "p2", baseURL: base, version: await version() });
  eq("duplicate provider name -> 400", r.status, 400);

  r = await call("GET", "/admin/providers/p2");
  const created = await r.json();
  t("created provider is readable", created.provider.name === "p2" && created.provider.auth === "bearer", created);
  eq("created provider is on disk", routes().providers.p2.baseURL, base);

  r = await call("PUT", "/admin/providers/p2", { baseURL: base + "/v2", dropBeta: true, disabled: true, version: created.version });
  const updated = await r.json();
  t("provider updated (dropBeta + disabled)", updated.provider.dropBeta === true && updated.provider.disabled === true, updated);
  eq("update is on disk", [routes().providers.p2.dropBeta, routes().providers.p2.disabled], [true, true]);

  r = await call("PUT", "/admin/providers/p2", { baseURL: base, disabled: false, version: await version() });
  t("provider re-enabled", (await r.json()).provider.disabled === false);

  r = await call("PUT", "/admin/providers/p2", { name: "p2-renamed", version: await version() });
  eq("provider rename refused", r.status, 400);

  r = await call("GET", "/admin/providers/nope");
  eq("unknown provider -> 404", r.status, 404);
}

// ───────────────────────── 4. keys are write-only ─────────────────────────
{
  let r = await call("POST", "/admin/providers/p2/keys", { envName: "bad name", value: FAKE_KEY, version: await version() });
  eq("invalid env var name -> 400", r.status, 400);

  r = await call("POST", "/admin/providers/p2/keys", { envName: "P2_K1", value: "x", version: await version() });
  eq("too-short key value -> 400", r.status, 400);

  r = await call("POST", "/admin/providers/p2/keys", { envName: "P2_K1", value: FAKE_KEY, version: await version() });
  const kres = await r.json();
  t("key added", r.status === 201 && kres.key.configured === true && kres.key.last4 === "9999", kres);
  t("key value is never echoed back", !JSON.stringify(kres).includes(FAKE_KEY));
  t("key value is in .env", envText().includes(`P2_K1=${FAKE_KEY}`));
  t("key value is NOT in routes.json", !fs.readFileSync(routesFile, "utf8").includes(FAKE_KEY));
  t("key value is NOT in the router log", !log.includes(FAKE_KEY));

  r = await call("GET", "/admin/providers/p2");
  const masked = await r.text();
  t("GET masks the value, exposing last 4", masked.includes("9999") && !masked.includes(FAKE_KEY));

  r = await call("GET", "/admin/snapshot");
  const snap = await r.text();
  t("snapshot masks the value too", snap.includes("9999") && !snap.includes(FAKE_KEY));

  r = await call("POST", "/admin/providers/p2/keys", { envName: "P2_K1", value: FAKE_KEY + "-rotated", version: await version() });
  t("replacing an existing key returns 200", r.status === 200, await r.text());
  t("replaced value is on disk", envText().includes(`P2_K1=${FAKE_KEY}-rotated`));
  eq("key was not duplicated in routes.json", routes().providers.p2.keys, ["P2_K1"]);
  await call("POST", "/admin/providers/p2/keys", { envName: "P2_K1", value: FAKE_KEY, version: await version() });
}

// ───────────────────────── 5. hot reload + a new key on the next request ─────────────────────────
{
  let r = await call("POST", "/admin/models", { alias: "c", provider: "p2", model: "real-c", version: await version() });
  t("model created", r.status === 201, await r.text());
  eq("model is on disk", routes().models.c.model, "real-c");

  upstreamHits = [];
  r = await fetch(R + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ROUTER_KEY },
    body: JSON.stringify({ model: "c", messages: [] }),
  });
  t("a newly added key is used by the very next /v1/messages (no restart)", r.status === 200);
  eq("the newly added key was the one used", upstreamHits.map((h) => h.key), [FAKE_KEY]);
}

// ───────────────────────── 6. model validation ─────────────────────────
{
  let r = await call("PUT", "/admin/models/c", { key: "P1_K2", version: await version() });
  let body = await r.json();
  t("pinning a key of another provider is refused", r.status === 400 && body.errors[0].field === "key", body);

  r = await call("PUT", "/admin/models/c", { maxOutputTokens: -5, version: await version() });
  t("negative maxOutputTokens refused", r.status === 400);
  r = await call("PUT", "/admin/models/c", { maxOutputTokens: 1.5, version: await version() });
  t("non-integer maxOutputTokens refused", r.status === 400);
  r = await call("PUT", "/admin/models/c", { price: { in: -1, out: 1 }, version: await version() });
  t("negative price refused", r.status === 400);
  r = await call("POST", "/admin/models", { alias: "sonnet", provider: "p1", model: "x", version: await version() });
  body = await r.json();
  t("reserved alias refused", r.status === 400 && /reserved/.test(body.errors[0].message), body);
  r = await call("POST", "/admin/models", { alias: "Bad Alias", provider: "p1", model: "x", version: await version() });
  t("alias charset enforced", r.status === 400);
  r = await call("POST", "/admin/models", { alias: "d", provider: "p1", model: "real-d", fallback: ["nope"], version: await version() });
  t("fallback to an unknown model refused", r.status === 400);
  r = await call("POST", "/admin/models", { alias: "e", provider: "ghost", model: "x", version: await version() });
  t("unknown provider refused", r.status === 400 && /unknown provider/.test((await r.json()).errors[0].message));

  r = await call("PUT", "/admin/models/b", { fallback: ["a"], version: await version() });
  body = await r.json();
  t("fallback cycle refused", r.status === 400 && /cycle/.test(body.errors[0].message), body);
  eq("the cycle was never written to disk", routes().models.b.fallback, undefined);

  r = await call("PUT", "/admin/models/c", { fallback: [], price: { in: 1, out: 2, cacheRead: 0.1 }, maxOutputTokens: 512, version: await version() });
  const m = await r.json();
  t("model updated", m.model.price.out === 2 && m.model.maxOutputTokens === 512, m);
  eq("update is on disk", routes().models.c.price, { in: 1, out: 2, cacheRead: 0.1 });

  r = await call("PUT", "/admin/models/c", { key: "P2_K1", version: await version() });
  t("pinning to its own provider's key works", (await r.json()).model.key === "P2_K1");
  r = await call("PUT", "/admin/models/c", { key: null, version: await version() });
  t("key: null returns the model to the pool", (await r.json()).model.key === undefined);
}

// ───────────────────────── 7. referential integrity + cascade ─────────────────────────
{
  let r = await call("DELETE", "/admin/providers/p1", undefined, await withVersion());
  const blocked = await r.json();
  eq("deleting a referenced provider -> 409", r.status, 409);
  eq("the blocker list names exactly the models", blocked.blockedBy?.map((b) => b.name).sort(), ["a", "b"]);
  eq("nothing was deleted", !!routes().models.a, true);

  r = await call("DELETE", "/admin/models/b", { version: await version() });
  const bBlocked = await r.json();
  eq("deleting a model used as a fallback -> 409", r.status, 409);
  eq("the model blocker list names a", bBlocked.blockedBy?.map((x) => `${x.type}:${x.name}`), ["fallback:a"]);

  r = await call("DELETE", "/admin/models/b?cascade=1", { version: await version() });
  const casc = await r.json();
  t("cascade delete of a model succeeds", r.status === 200, casc);
  eq("the model is gone", routes().models.b, undefined);
  t("fallback references cleaned", casc.cleanedReferences.includes("models.a.fallback"), casc.cleanedReferences);
  eq("the cleaned fallback is really empty", routes().models.a.fallback, undefined);

  r = await call("DELETE", "/admin/providers/p1?cascade=1", undefined, await withVersion());
  const casc2 = await r.json();
  t("cascade delete of a provider succeeds", r.status === 200, casc2);
  t("its models were removed too", routes().models.a === undefined, Object.keys(routes().models));
  t("defaultModel cleaned", casc2.cleanedReferences.includes("defaultModel"), casc2.cleanedReferences);
  t("alias mapping cleaned", casc2.cleanedReferences.includes("aliases.sonnet"), casc2.cleanedReferences);
  eq("provider gone from disk", routes().providers.p1, undefined);

  r = await call("DELETE", "/admin/providers/p1", undefined, await withVersion());
  eq("deleting a missing provider -> 404", r.status, 404);
}

// ───────────────────────── 8. concurrency ─────────────────────────
{
  const stale = await version();
  await call("PUT", "/admin/models/c", { model: "real-c2", version: await version() });
  let r = await call("PUT", "/admin/models/c", { model: "real-c3", version: stale });
  const conflict = await r.json();
  eq("stale version -> 409", r.status, 409);
  t("the 409 body carries the current version", typeof conflict.currentVersion === "string", conflict);
  eq("the stale write was not applied", routes().models.c.model, "real-c2");

  r = await call("PUT", "/admin/models/c", { model: "x" });
  eq("missing version -> 400", r.status, 400);
  r = await call("DELETE", "/admin/models/c");
  eq("DELETE without version -> 400", r.status, 400);
}

// ───────────────────────── 9. atomic writes + backups ─────────────────────────
{
  t("backups dir created", fs.existsSync(backupDir));
  const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith("routes.json-"));
  t("routes.json is backed up before each write", backups.length >= 1, backups.length);
  t("the backup is valid JSON", !!JSON.parse(fs.readFileSync(path.join(backupDir, backups.at(-1)), "utf8")).models);
  t(".env is backed up too", fs.readdirSync(backupDir).some((f) => f.startsWith(".env-")));

  for (let i = 0; i < 6; i++) {
    await call("PUT", "/admin/models/c", { model: "real-c" + i, version: await version() });
  }
  eq("routes.json stays valid after repeated writes", routes().models.c.model.startsWith("real-c"), true);
  t("no temp file is left behind", !fs.readdirSync(home).some((f) => f.includes(".tmp-")), fs.readdirSync(home));
}

// ───────────────────────── 10. live tracking: in-flight, failover, counters ─────────────────────────
{
  await call("POST", "/admin/providers", { name: "slow", baseURL: base, auth: "x-api-key", version: await version() });
  await call("POST", "/admin/providers/slow/keys", { envName: "SLOW_K1", value: "K-SLOW", version: await version() });
  await call("POST", "/admin/providers", { name: "flaky", baseURL: base, auth: "x-api-key", version: await version() });
  await call("POST", "/admin/providers/flaky/keys", { envName: "FLAKY_K1", value: RATELIMIT_KEY, version: await version() });
  await call("POST", "/admin/providers/flaky/keys", { envName: "FLAKY_K2", value: FAKE_KEY2, version: await version() });
  await call("POST", "/admin/models", { alias: "slow", provider: "slow", model: "real-slow", version: await version() });
  await call("POST", "/admin/models", { alias: "flaky", provider: "flaky", model: "real-flaky", version: await version() });

  let release;
  const held = new Promise((r) => (release = r));
  streamGate = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n');
    held.then(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
  };

  const inflightReq = fetch(R + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ROUTER_KEY },
    body: JSON.stringify({ model: "slow", stream: true, messages: [] }),
  });

  let snap = null;
  for (let i = 0; i < 40 && !(snap && snap.inFlight.length); i++) {
    await new Promise((r) => setTimeout(r, 50));
    snap = await snapshot();
  }
  const flying = snap?.inFlight?.[0];
  t("an in-flight streaming request shows up in /admin/snapshot", !!flying, snap?.inFlight);
  eq("it reports alias/provider/key", flying && [flying.alias, flying.provider, flying.keyName], ["slow", "slow", "SLOW_K1"]);
  t("it reports the streaming state", flying?.status === "streaming", flying?.status);

  const sse = await fetch(R + "/admin/events", { headers: { ...H, accept: "text/event-stream" } });
  const sseReader = sse.body.getReader();
  const frame = new TextDecoder().decode((await sseReader.read()).value);
  t("SSE pushes a snapshot frame on connect", frame.includes("event: snapshot"));
  await sseReader.cancel();

  release();
  await inflightReq;
  streamGate = null;
  await new Promise((r) => setTimeout(r, 250));
  snap = await snapshot();
  eq("in-flight clears when the request finishes", snap.inFlight.length, 0);
  t("the finished request moved to recent", snap.recent.some((r) => r.alias === "slow"));

  // Key order is sticky (hash of the session seed), so try a few seeds until the
  // rate-limited key is picked first and the request has to fail over.
  upstreamHits = [];
  const codes = [];
  for (let i = 0; i < 4; i++) {
    codes.push((await fetch(R + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ROUTER_KEY },
      body: JSON.stringify({ model: "flaky", system: "seed-" + i, messages: [] }),
    })).status);
  }
  t("a forced failover never surfaces to the client", codes.every((c) => c === 200), codes);
  t("the rate-limited key was actually attempted", upstreamHits.some((h) => h.key === RATELIMIT_KEY));
  await new Promise((x) => setTimeout(x, 200));
  snap = await snapshot();
  const failed = snap.recent.filter((x) => x.alias === "flaky" && x.failover).at(-1);
  t("the failover is recorded with its reason", failed?.failover?.status === 429, failed);
  eq("it names the key that failed", failed?.failover?.from, "FLAKY_K1");
  eq("it names the key that served it", failed?.key, "FLAKY_K2");
  t("rolling counters tracked the requests", snap.counters.m1.requests >= 4, snap.counters);
  eq("a transparent failover is not counted as a client-visible error", snap.counters.m1.errors, 0);
  t("per-provider 5m counters tracked it", snap.providers.find((p) => p.name === "flaky").last5m.requests >= 4);

  t("the cooldown is visible for the rate-limited key", (snap.cooldowns.FLAKY_K1 || 0) > 0, snap.cooldowns);
  const reset = await (await call("POST", "/admin/keys/FLAKY_K1/reset-cooldown")).json();
  t("reset-cooldown clears it", reset.cleared === true, reset);
  eq("cooldown gone after reset", (await snapshot()).cooldowns.FLAKY_K1, 0);
}

// ───────────────────────── 11. disabled providers ─────────────────────────
{
  await call("POST", "/admin/providers/flaky/disable", { version: await version() });
  upstreamHits = [];
  const r = await fetch(R + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ROUTER_KEY },
    body: JSON.stringify({ model: "flaky", messages: [] }),
  });
  eq("a disabled provider is skipped by the router", r.status, 503);
  eq("and receives no traffic at all", upstreamHits.length, 0);
  await call("POST", "/admin/providers/flaky/enable", { version: await version() });
  const snap = await snapshot();
  eq("enable clears the flag", snap.providers.find((p) => p.name === "flaky").disabled, false);
  const live = await fetch(R + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ROUTER_KEY },
    body: JSON.stringify({ model: "flaky", messages: [] }),
  });
  eq("traffic flows again once enabled", live.status, 200);
}

// ───────────────────────── 12. the ONLY upstream call: /test ─────────────────────────
{
  const logFile = path.join(home, "logs", "usage.jsonl");
  const countLines = () => { try { return fs.readFileSync(logFile, "utf8").trim().split("\n").length; } catch { return 0; } };
  upstreamHits = [];
  let r = await call("POST", "/admin/models/slow/test", {});
  eq("/test without confirm -> 400", r.status, 400);
  eq("and it calls nothing", upstreamHits.length, 0);

  const usageLinesBefore = countLines();
  r = await call("POST", "/admin/models/slow/test", { confirm: true });
  const usageLinesAfter = countLines();
  const res = await r.json();
  t("/test with confirm succeeds", r.status === 200 && res.ok === true, res);
  eq("exactly one upstream call", upstreamHits.length, 1);
  eq("with max_tokens 1", upstreamHits[0].max_tokens, 1);
  t("it never returns the key value", !JSON.stringify(res).includes("K-SLOW"));
  eq("the test call is not recorded as usage", usageLinesAfter, usageLinesBefore);
}

// ───────────────────────── 13. usage summary ─────────────────────────
{
  const u = await (await fetch(R + "/admin/usage/summary?range=1h", { headers: H })).json();
  t("usage aggregates by model", u.byAlias.length >= 2, u.byAlias.map((a) => a.name));
  t("usage aggregates by provider", u.byProvider.length >= 2, u.byProvider.map((a) => a.name));
  t("usage counts requests", u.totals.requests >= 3, u.totals);
  t("cache-hit ratio is computed", typeof u.byAlias[0].cacheHitRatio === "number");
  t("cost is computed from price", u.byAlias.find((a) => a.name === "c").cost >= 0);
  t("timeline has buckets", u.timeline.length >= 1);
  t("top-10 largest requests listed", Array.isArray(u.top));

  fs.appendFileSync(path.join(home, "logs", "usage.jsonl"), "{not json\n\n");
  const u2 = await (await fetch(R + "/admin/usage/summary?range=1h", { headers: H })).json();
  t("corrupt log lines are skipped, not fatal", u2.corruptLines >= 1, u2.corruptLines);
  eq("an unknown range falls back to 1h", u2.range, "1h");
}

// ───────────────────────── 14. settings ─────────────────────────
{
  let r = await call("PUT", "/admin/settings", { defaultModel: "nope", version: await version() });
  eq("unknown defaultModel -> 400", r.status, 400);
  r = await call("PUT", "/admin/settings", { aliases: { opus: "ghost" }, version: await version() });
  eq("alias pointing at a missing model -> 400", r.status, 400);

  r = await call("PUT", "/admin/settings", { defaultModel: "slow", aliases: { opus: "c", sonnet: "c", haiku: "slow" }, version: await version() });
  const saved = await r.json();
  t("settings saved", r.status === 200, saved);
  eq("defaultModel on disk", routes().defaultModel, "slow");
  eq("aliases on disk", routes().aliases, { opus: "c", sonnet: "c", haiku: "slow" });
}

// ───────────────────────── 15. secrets never leak ─────────────────────────
{
  const responses = [];
  for (const p of ["/admin/snapshot", "/admin/providers", "/admin/providers/slow", "/admin/models",
                   "/admin/settings", "/admin/status", "/admin/usage/summary?range=7d"]) {
    responses.push(await (await fetch(R + p, { headers: H })).text());
  }
  const routesBackups = fs.readdirSync(backupDir).filter((f) => f.startsWith("routes.json-"));
  const leaked = [
    ["API responses", responses.join("\n")],
    ["routes.json", fs.readFileSync(routesFile, "utf8")],
    ["routes.json backups", routesBackups.map((f) => fs.readFileSync(path.join(backupDir, f), "utf8")).join("")],
    ["router log", log],
  ];
  for (const [where, text] of leaked) {
    t(`no full key value in ${where}`,
      !text.includes(FAKE_KEY) && !text.includes(FAKE_KEY2) && !text.includes(RATELIMIT_KEY));
  }
  t("the last 4 chars ARE exposed for configured keys", responses[0].includes("9999"));
  // .env backups are full copies of the secret file - that is what makes restore work.
  t("but .env backups do hold the values (that is the restore point)",
    fs.readdirSync(backupDir).some((f) => f.startsWith(".env-") && fs.readFileSync(path.join(backupDir, f), "utf8").includes(FAKE_KEY2)));
}

// ───────────────────────── 16. key removal edits .env ─────────────────────────
{
  const r = await call("DELETE", "/admin/providers/slow/keys/SLOW_K1", { version: await version() });
  t("key removed", r.status === 200, await r.text());
  t("the line is gone from .env", !envText().includes("SLOW_K1"));
  t("unrelated .env lines are untouched", envText().includes("ROUTER_KEY") && envText().includes("P2_K1"));
  t("the env var name is gone from routes.json", !fs.readFileSync(routesFile, "utf8").includes("SLOW_K1"));
  eq("key count updated in the snapshot", (await snapshot()).providers.find((p) => p.name === "slow").keysTotal, 0);

  const again = await call("DELETE", "/admin/providers/slow/keys/SLOW_K1", { version: await version() });
  eq("removing a missing key -> 404", again.status, 404);
}

// ───────────────────────── 17. pinned-key integrity ─────────────────────────
{
  await call("PUT", "/admin/models/c", { key: "P2_K1", version: await version() });
  let r = await call("DELETE", "/admin/providers/p2/keys/P2_K1", { version: await version() });
  const blocked = await r.json();
  eq("removing a pinned key -> 409", r.status, 409);
  eq("the blocker names the pinning model", blocked.blockedBy?.map((b) => b.name), ["c"]);
  r = await call("DELETE", "/admin/providers/p2/keys/P2_K1?cascade=1", { version: await version() });
  t("cascade unpins and removes it", r.status === 200, await r.text());
  eq("the model is back on the pool", routes().models.c.key, undefined);
}

// ───────────────────────── 18. SSE client cap ─────────────────────────
{
  const open = [];
  let refused = 0;
  for (let i = 0; i < 6; i++) {
    const ac = new AbortController();
    const r = await fetch(R + "/admin/events", { headers: { ...H, accept: "text/event-stream" }, signal: ac.signal });
    if (r.status === 200) { open.push(ac); await r.body.getReader().read(); }
    else if (r.status === 429) refused++;
  }
  eq("a 6th SSE client is refused with 429", refused, 1);
  for (const ac of open) ac.abort();
  await new Promise((r) => setTimeout(r, 300));
  eq("slots are freed when clients disconnect", (await snapshot()).sseClients, 0);
}

// ───────────────────────── 19. regression: unchanged endpoints ─────────────────────────
{
  const st = await (await fetch(R + "/admin/status", { headers: H })).json();
  t("legacy /admin/status still works", !!st.providers && !!st.models);
  t("legacy /admin/status never leaks values", !JSON.stringify(st).includes(FAKE_KEY));
  t("legacy /admin/usage still works", !!(await (await fetch(R + "/admin/usage", { headers: H })).json()));
  t("/v1/models still works", (await (await fetch(R + "/v1/models", { headers: H })).json()).data.length >= 1);
  t("/health still works unauthenticated", (await fetch(R + "/health")).status === 200);
  const ct = await fetch(R + "/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ROUTER_KEY },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  t("count_tokens stays local", ct.status === 200 && (await ct.json()).input_tokens > 0);
  const nf = await fetch(R + "/admin/nope", { headers: H });
  eq("unknown admin endpoint -> 404", nf.status, 404);
}

child.kill();
mock.close();
console.log(fails ? `\n${fails} FAILED\n${log}` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
