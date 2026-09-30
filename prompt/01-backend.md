# 01 — Backend: database, sign-in, request history, keyless providers, key discovery

**Run this first.** It changes the Node server only (`src/*.ts`). Steps 02–04 depend on it.

## What this step adds and why

- **SQLite database** (`data/router.db`, built into Node — no new npm package). Holds users, sessions, settings and a permanent **request history**. Before this, history lived only in memory and vanished on restart. Your existing `logs/usage.jsonl` is imported on first start so History is not empty.
- **Sign-in with username + password** instead of pasting ROUTER_KEY into a browser prompt. Passwords are hashed with scrypt (built into Node). The browser gets an HttpOnly, SameSite=Strict cookie, so `fetch` and the live stream authenticate by themselves and the key prompt can never repeat. Roles: `admin` (can change things, manage users) and `user` (read-only). ROUTER_KEY keeps working for Claude Code, `scripts/statusline.mjs` and scripts.
- **First-run setup**: with zero users, `/ui` shows "create the admin account" (allowed from this machine only). Optional headless seed with `ADMIN_USER` / `ADMIN_PASSWORD` in `.env`.
- **Request history + analytics**: every finished request (success, failure, client abort) is stored with fresh input, cache read, output, whole-prompt size (`ctx`), timing and cost. New endpoints: `GET /admin/requests` (search/filter/paging, includes running requests), `GET /admin/insights` (prompt-size percentiles, cache-hit %, compaction count, top sessions).
- **Providers**: `auth: "none"` for keyless upstreams (local Ollama / LM Studio — this fixes models stuck at "0/0 ready"); create a provider **with its keys in one call**; `GET /admin/env/keys` lists key-like variables found in `.env`; `POST /admin/providers/:name/keys/attach` adds existing `.env` variables (e.g. your `OPENCODE_KEY_2..4`) to a provider's pool without touching their values.
- **Cost**: one shared `costOf()` with an optional DeepSeek peak-hours multiplier (`price.peak`).
- **Settings API**: `GET/PUT /admin/app-settings` (retention days, large-prompt warning, peak multiplier, project name) and `GET /admin/system`.
- **One URL per page**: the server now answers `/ui/*` with the app shell so a refresh keeps the page, and `/` redirects to `/ui/live`.
- **CSP**: `'wasm-unsafe-eval'` added to `script-src` (needed by the syntax highlighter; still no `eval`).

## How to work (read this first)

- This file is **complete**. Everything you need is below. **Do not open, search or read any other file or folder.**
  If a step says "replace the whole file" you do not need to read the old one. If a step is a diff, open **only that one file** to apply it.
- Diffs are unified diffs with 3 lines of context. Apply each from the repo root with
  `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first), or edit by hand: `-` lines are removed, `+` lines are added, everything else is context.
  If a hunk does not match because the line already looks like the `+` version, skip that hunk and say so.
- Files in this repo use Windows line endings (CRLF). Keep each existing file's line endings. New files may use either.
- Do not change anything that is not listed. No refactors, no renames, no formatting changes.
- Never print, log, or commit `.env` values.
- When done, run the verification commands at the end and paste their **real output**. If one fails, fix only what the failure points to, then re-run it.

## Steps

### Step 1 — Create these four new files

### `src/db.ts` — NEW file

````ts
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ROOT } from "./config";

// node:sqlite still prints an ExperimentalWarning on some Node versions; drop only that one.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (/SQLite/i.test(text)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/**
 * One SQLite file for everything that must survive a restart and is not a secret
 * provider key: users, sessions, settings and the request history.
 * Provider API keys stay in .env only; routes.json stays the routing source of truth.
 */
export const DATA_DIR = path.join(ROOT, process.env.DATA_DIR ?? "data");
export const DB_FILE = path.join(DATA_DIR, "router.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db: DatabaseSyncType = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     pass_hash TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin','user')),
     disabled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     last_login_at INTEGER
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     ip TEXT,
     ua TEXT
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE requests (
     id TEXT PRIMARY KEY,
     session_id TEXT,
     alias TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     key_name TEXT,
     status INTEGER NOT NULL,
     stream INTEGER NOT NULL DEFAULT 0,
     failover INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER NOT NULL,
     first_token_at INTEGER,
     ended_at INTEGER NOT NULL,
     duration_ms INTEGER,
     ttft_ms INTEGER,
     in_tokens INTEGER NOT NULL DEFAULT 0,
     out_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read INTEGER NOT NULL DEFAULT 0,
     cache_write INTEGER NOT NULL DEFAULT 0,
     ctx_tokens INTEGER NOT NULL DEFAULT 0,
     cost REAL NOT NULL DEFAULT 0,
     tps REAL
   );
   CREATE INDEX idx_requests_started ON requests(started_at DESC);
   CREATE INDEX idx_requests_alias ON requests(alias, started_at DESC);
   CREATE INDEX idx_requests_session ON requests(session_id, started_at);
   CREATE INDEX idx_sessions_expires ON sessions(expires_at);`,
];

function migrate(): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  let v = row.v ?? 0;
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      v += 1;
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(v);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
migrate();

// ---------- settings (typed defaults live here; the UI edits them) ----------
export const SETTING_DEFAULTS = {
  "history.retentionDays": 30,
  "context.warnTokens": 100_000,
  "pricing.peakMultiplier": 1,
  "ui.projectName": "Claude Router",
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;

export function getSetting<K extends SettingKey>(key: K): (typeof SETTING_DEFAULTS)[K] {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!r) return SETTING_DEFAULTS[key];
  try {
    return JSON.parse(r.value);
  } catch {
    return SETTING_DEFAULTS[key];
  }
}

export function allSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const k of Object.keys(SETTING_DEFAULTS) as SettingKey[]) out[k] = getSetting(k);
  return out;
}

export function setSetting(key: string, value: unknown): void {
  if (!(key in SETTING_DEFAULTS)) throw new Error(`unknown setting "${key}"`);
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    key,
    JSON.stringify(value),
  );
}
````

### `src/auth.ts` — NEW file

````ts
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "./db";

// ---------- passwords (scrypt, per-user random salt) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64"), want.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- model ----------
export type Role = "admin" | "user";
export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}
export type Principal = { kind: "key" } | { kind: "user"; user: AuthUser };

interface UserRow {
  id: number; username: string; pass_hash: string; role: Role;
  disabled: number; created_at: number; last_login_at: number | null;
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const now = () => Date.now();

class HttpError extends Error {
  constructor(public status: number, public type: string, message: string, public errors?: { field: string; message: string }[]) {
    super(message);
  }
}

function checkUsername(u: unknown): string {
  if (typeof u !== "string" || !USERNAME_RE.test(u)) {
    throw new HttpError(400, "validation_error", "invalid username", [
      { field: "username", message: "3-32 characters: letters, digits, dot, underscore, dash" },
    ]);
  }
  return u;
}

function checkPassword(p: unknown, field = "password"): string {
  if (typeof p !== "string" || p.length < 8 || p.length > 200) {
    throw new HttpError(400, "validation_error", "invalid password", [
      { field, message: "must be 8-200 characters" },
    ]);
  }
  return p;
}

const publicUser = (r: UserRow) => ({
  id: r.id, username: r.username, role: r.role, disabled: !!r.disabled,
  createdAt: r.created_at, lastLoginAt: r.last_login_at,
});

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

function activeAdminCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get() as { n: number }).n;
}

export function createUser(username: unknown, password: unknown, role: unknown): AuthUser {
  const u = checkUsername(username);
  const pw = checkPassword(password);
  if (role !== "admin" && role !== "user") {
    throw new HttpError(400, "validation_error", "invalid role", [{ field: "role", message: "must be admin or user" }]);
  }
  try {
    const r = db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)")
      .run(u, hashPassword(pw), role, now());
    return { id: Number(r.lastInsertRowid), username: u, role };
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) {
      throw new HttpError(409, "conflict_error", "username already exists", [{ field: "username", message: "already taken" }]);
    }
    throw e;
  }
}

/** Headless installs: ADMIN_USER + ADMIN_PASSWORD in .env create the first admin at startup. */
export function seedAdminFromEnv(): void {
  const u = process.env.ADMIN_USER, p = process.env.ADMIN_PASSWORD;
  if (userCount() > 0 || !u || !p) return;
  try {
    createUser(u, p, "admin");
    console.log(`[AUTH] created admin "${u}" from ADMIN_USER/ADMIN_PASSWORD (remove the password from .env now)`);
  } catch (e) {
    console.warn(`[AUTH] ADMIN_USER seed failed: ${(e as Error).message}`);
  }
}

// ---------- sessions ----------
export const COOKIE = "router_session";
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = String(req.headers.cookie ?? "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function setCookie(res: ServerResponse, token: string, maxAgeSec: number): void {
  res.setHeader("set-cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);
}

function startSession(req: IncomingMessage, res: ServerResponse, userId: number): void {
  const token = crypto.randomBytes(32).toString("base64url");
  const t = now();
  db.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen,ip,ua) VALUES(?,?,?,?,?,?,?)").run(
    hashToken(token), userId, t, t + SESSION_TTL_MS, t,
    req.socket.remoteAddress ?? "", String(req.headers["user-agent"] ?? "").slice(0, 200),
  );
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t);
  setCookie(res, token, SESSION_TTL_MS / 1000);
}

export function sessionUser(req: IncomingMessage): AuthUser | null {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const id = hashToken(token);
  const r = db.prepare(
    `SELECT u.id, u.username, u.role, s.expires_at, s.last_seen FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.disabled = 0`,
  ).get(id) as { id: number; username: string; role: Role; expires_at: number; last_seen: number } | undefined;
  if (!r || r.expires_at < now()) return null;
  if (now() - r.last_seen > 3600_000) {
    db.prepare("UPDATE sessions SET last_seen=?, expires_at=? WHERE id=?").run(now(), now() + SESSION_TTL_MS, id);
  }
  return { id: r.id, username: r.username, role: r.role };
}

// ---------- brute-force throttle ----------
const fails = new Map<string, { n: number; until: number }>();
function throttleKey(req: IncomingMessage, username: string): string {
  return `${req.socket.remoteAddress ?? ""}|${username.toLowerCase()}`;
}
function lockedFor(k: string): number {
  return Math.max(0, (fails.get(k)?.until ?? 0) - now());
}
function noteFail(k: string): void {
  const f = fails.get(k) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) f.until = now() + Math.min(30_000 * 2 ** (f.n - 5), 15 * 60_000);
  fails.set(k, f);
}

// ---------- principal ----------
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function headerKeyOk(req: IncomingMessage, routerKey: string): boolean {
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const xk = String(req.headers["x-api-key"] ?? "");
  return safeEq(bearer, routerKey) || safeEq(xk, routerKey);
}

/** ROUTER_KEY header (Claude Code, scripts) or a logged-in browser session. */
export function principal(req: IncomingMessage, routerKey: string): Principal | null {
  if (headerKeyOk(req, routerKey)) return { kind: "key" };
  const user = sessionUser(req);
  return user ? { kind: "user", user } : null;
}

export const canWrite = (p: Principal): boolean => p.kind === "key" || p.user.role === "admin";

// ---------- http plumbing ----------
function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(res.getHeader("set-cookie") ? { "set-cookie": res.getHeader("set-cookie") as string } : {}) });
  res.end(JSON.stringify(data));
}

async function readJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "invalid_request_error", "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid_request_error", "Body is not valid JSON");
  }
}

const isLoopback = (req: IncomingMessage) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? "");

/**
 * Handles /admin/auth/* and /admin/users*. Returns true when it answered the request.
 * `guards` = host/origin checks owned by admin.ts (passed in to avoid a circular import).
 */
export async function handleAuthRoutes(
  req: IncomingMessage, res: ServerResponse, pathname: string, routerKey: string,
  guards: { hostOk: boolean; originOk: boolean },
): Promise<boolean> {
  const isAuth = pathname.startsWith("/admin/auth/");
  const isUsers = pathname === "/admin/users" || pathname.startsWith("/admin/users/");
  if (!isAuth && !isUsers) return false;
  const method = req.method ?? "GET";
  try {
    if (!guards.hostOk) throw new HttpError(403, "forbidden_error", "Host header not allowed");
    if (method !== "GET" && !guards.originOk) throw new HttpError(403, "forbidden_error", "Cross-origin request refused");
    if (method !== "GET" && !/application\/json/i.test(String(req.headers["content-type"] ?? ""))) {
      throw new HttpError(415, "invalid_request_error", "content-type must be application/json");
    }

    if (pathname === "/admin/auth/status" && method === "GET") {
      const user = sessionUser(req);
      send(res, 200, { needsSetup: userCount() === 0, authenticated: !!user, user: user ?? null });
      return true;
    }

    if (pathname === "/admin/auth/setup" && method === "POST") {
      if (userCount() > 0) throw new HttpError(409, "conflict_error", "Setup already completed");
      if (!isLoopback(req)) throw new HttpError(403, "forbidden_error", "First-run setup is only allowed from this machine");
      const b = await readJSON(req);
      const user = createUser(b.username, b.password, "admin");
      startSession(req, res, user.id);
      send(res, 201, { user });
      return true;
    }

    if (pathname === "/admin/auth/login" && method === "POST") {
      const b = await readJSON(req);
      const username = typeof b.username === "string" ? b.username : "";
      const k = throttleKey(req, username);
      const wait = lockedFor(k);
      if (wait > 0) {
        res.setHeader("retry-after", String(Math.ceil(wait / 1000)));
        throw new HttpError(429, "rate_limit_error", `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s`);
      }
      const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as unknown as UserRow | undefined;
      // Always run one scrypt so unknown users cost the same as wrong passwords.
      const ok = verifyPassword(String(b.password ?? ""), row?.pass_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
      if (!row || row.disabled || !ok) {
        noteFail(k);
        throw new HttpError(401, "authentication_error", "Invalid username or password");
      }
      fails.delete(k);
      db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(now(), row.id);
      startSession(req, res, row.id);
      send(res, 200, { user: { id: row.id, username: row.username, role: row.role } });
      return true;
    }

    if (pathname === "/admin/auth/logout" && method === "POST") {
      const token = cookieValue(req, COOKIE);
      if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
      setCookie(res, "", 0);
      send(res, 200, { ok: true });
      return true;
    }

    // Everything below needs a signed-in user (or the machine key).
    const who = principal(req, routerKey);
    if (!who) throw new HttpError(401, "authentication_error", "Sign in required");

    if (pathname === "/admin/auth/password" && method === "POST") {
      if (who.kind !== "user") throw new HttpError(400, "invalid_request_error", "Only signed-in users have a password");
      const b = await readJSON(req);
      const row = db.prepare("SELECT * FROM users WHERE id = ?").get(who.user.id) as unknown as UserRow;
      if (!verifyPassword(String(b.current ?? ""), row.pass_hash)) {
        throw new HttpError(400, "validation_error", "current password is wrong", [{ field: "current", message: "is wrong" }]);
      }
      const next = checkPassword(b.next, "next");
      db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(hashPassword(next), row.id);
      const token = cookieValue(req, COOKIE);
      db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").run(row.id, token ? hashToken(token) : "");
      send(res, 200, { ok: true });
      return true;
    }

    if (isUsers) {
      if (!(who.kind === "key" || who.user.role === "admin")) throw new HttpError(403, "forbidden_error", "Admin only");
      const selfId = who.kind === "user" ? who.user.id : -1;

      if (pathname === "/admin/users" && method === "GET") {
        const rows = db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[];
        send(res, 200, { users: rows.map(publicUser) });
        return true;
      }
      if (pathname === "/admin/users" && method === "POST") {
        const b = await readJSON(req);
        const user = createUser(b.username, b.password, b.role ?? "user");
        send(res, 201, { user });
        return true;
      }
      const m = pathname.match(/^\/admin\/users\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow | undefined;
        if (!row) throw new HttpError(404, "not_found_error", "No such user");

        if (method === "PATCH") {
          const b = await readJSON(req);
          if (id === selfId && (b.role !== undefined || b.disabled !== undefined)) {
            throw new HttpError(400, "invalid_request_error", "You cannot change your own role or disable yourself");
          }
          let role = row.role, disabled = row.disabled;
          if (b.role !== undefined) {
            if (b.role !== "admin" && b.role !== "user") throw new HttpError(400, "validation_error", "invalid role", [{ field: "role", message: "must be admin or user" }]);
            role = b.role;
          }
          if (b.disabled !== undefined) disabled = b.disabled === true ? 1 : 0;
          if (row.role === "admin" && !row.disabled && (role !== "admin" || disabled) && activeAdminCount() <= 1) {
            throw new HttpError(409, "conflict_error", "This is the last active admin");
          }
          db.prepare("UPDATE users SET role=?, disabled=? WHERE id=?").run(role, disabled, id);
          if (b.password !== undefined) {
            db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(hashPassword(checkPassword(b.password)), id);
          }
          if (disabled || b.password !== undefined) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
          send(res, 200, { user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id) as unknown as UserRow) });
          return true;
        }
        if (method === "DELETE") {
          if (id === selfId) throw new HttpError(400, "invalid_request_error", "You cannot delete yourself");
          if (row.role === "admin" && !row.disabled && activeAdminCount() <= 1) {
            throw new HttpError(409, "conflict_error", "This is the last active admin");
          }
          db.prepare("DELETE FROM users WHERE id=?").run(id);
          send(res, 200, { ok: true });
          return true;
        }
      }
    }
    throw new HttpError(404, "not_found_error", "Not found");
  } catch (e) {
    if (e instanceof HttpError) {
      send(res, e.status, {
        type: "error", error: { type: e.type, message: e.message }, ...(e.errors ? { errors: e.errors } : {}),
      });
      return true;
    }
    throw e;
  }
}
````

### `src/history.ts` — NEW file

````ts
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";
import { db, getSetting } from "./db";
import type { InFlight, RecentEntry } from "./live";

const insert = db.prepare(`INSERT OR REPLACE INTO requests
  (id, session_id, alias, provider, model, key_name, status, stream, failover, started_at, first_token_at,
   ended_at, duration_ms, ttft_ms, in_tokens, out_tokens, cache_read, cache_write, ctx_tokens, cost, tps)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

/** Called for every finished request, including failures and aborts. Never throws. */
export function recordFinished(id: string, e: RecentEntry, f?: InFlight): void {
  try {
    const dur = e.durationMs ?? e.ms;
    insert.run(
      id, e.sessionId ?? null, e.alias, e.provider, e.model, e.key, e.status,
      f?.stream ? 1 : 0, e.failover || f?.failover ? 1 : 0,
      e.startedAt ?? e.ts - dur, e.firstTokenAt ?? null, e.ts, dur, e.ttftMs ?? null,
      e.in, e.out, e.cacheRead, e.cacheWrite, e.in + e.cacheRead + e.cacheWrite, e.cost, e.outputTokensPerSec ?? null,
    );
  } catch (err) {
    console.warn("[HISTORY] write failed:", (err as Error).message);
  }
}

export interface HistoryRow {
  id: string; sessionId: string | null; alias: string; provider: string; model: string; key: string | null;
  status: number; stream: boolean; failover: boolean; startedAt: number; firstTokenAt: number | null;
  endedAt: number; durationMs: number | null; ttftMs: number | null; in: number; out: number;
  cacheRead: number; cacheWrite: number; ctx: number; cost: number; tps: number | null;
}

type Row = Record<string, string | number | null>;
const toRow = (r: Row): HistoryRow => ({
  id: r.id as string, sessionId: r.session_id as string | null, alias: r.alias as string,
  provider: r.provider as string, model: r.model as string, key: r.key_name as string | null,
  status: r.status as number, stream: !!r.stream, failover: !!r.failover,
  startedAt: r.started_at as number, firstTokenAt: r.first_token_at as number | null,
  endedAt: r.ended_at as number, durationMs: r.duration_ms as number | null, ttftMs: r.ttft_ms as number | null,
  in: r.in_tokens as number, out: r.out_tokens as number, cacheRead: r.cache_read as number,
  cacheWrite: r.cache_write as number, ctx: r.ctx_tokens as number, cost: r.cost as number, tps: r.tps as number | null,
});

export interface HistoryQuery {
  limit?: number; before?: number; status?: "ok" | "error"; alias?: string; provider?: string;
  q?: string; minCtx?: number;
}

export function listRequests(q: HistoryQuery): { rows: HistoryRow[]; hasMore: boolean; total: number } {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 50), 1), 500);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.status === "ok") where.push("status < 400");
  if (q.status === "error") where.push("status >= 400");
  if (q.alias) { where.push("alias = ?"); args.push(q.alias); }
  if (q.provider) { where.push("provider = ?"); args.push(q.provider); }
  if (q.minCtx) { where.push("ctx_tokens >= ?"); args.push(q.minCtx); }
  if (q.q) {
    where.push("(alias LIKE ? OR model LIKE ? OR provider LIKE ? OR id LIKE ? OR session_id LIKE ?)");
    const like = `%${q.q.replace(/[%_]/g, "")}%`;
    args.push(like, like, like, like, like);
  }
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM requests ${base}`).get(...args) as { n: number }).n;
  const paged = q.before ? `${base ? base + " AND" : "WHERE"} ended_at < ?` : base;
  const rows = db.prepare(`SELECT * FROM requests ${paged} ORDER BY ended_at DESC LIMIT ?`)
    .all(...args, ...(q.before ? [q.before] : []), limit + 1) as unknown as Row[];
  return { rows: rows.slice(0, limit).map(toRow), hasMore: rows.length > limit, total };
}

const pct = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

/** Token/context analytics over a time window. All numbers come from the request history. */
export function insights(sinceMs: number) {
  const since = Date.now() - sinceMs;
  const rows = db.prepare(
    "SELECT session_id, started_at, ended_at, status, in_tokens, out_tokens, cache_read, cache_write, ctx_tokens, cost FROM requests WHERE ended_at >= ? ORDER BY session_id, started_at",
  ).all(since) as unknown as Row[];

  const t = { requests: 0, errors: 0, fresh: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const ctxs: number[] = [];
  const warn = Number(getSetting("context.warnTokens"));
  let overWarn = 0, compactions = 0;
  const sessions = new Map<string, { requests: number; ctxTotal: number; maxCtx: number; startedAt: number; endedAt: number }>();
  let prevSession: unknown = null, prevCtx = 0;
  const hourly = new Map<number, { t: number; requests: number; ctx: number; out: number; cacheRead: number }>();

  for (const r of rows) {
    const ctx = r.ctx_tokens as number;
    t.requests++; if ((r.status as number) >= 400) t.errors++;
    t.fresh += r.in_tokens as number; t.out += r.out_tokens as number;
    t.cacheRead += r.cache_read as number; t.cacheWrite += r.cache_write as number; t.cost += r.cost as number;
    if (ctx > 0) ctxs.push(ctx);
    if (ctx >= warn) overWarn++;
    // A compaction shows up as the context of the next request in a session collapsing.
    if (r.session_id === prevSession && prevCtx > 20_000 && ctx < prevCtx * 0.6) compactions++;
    prevSession = r.session_id; prevCtx = ctx;
    const sid = String(r.session_id ?? "unknown");
    const s = sessions.get(sid) ?? { requests: 0, ctxTotal: 0, maxCtx: 0, startedAt: r.started_at as number, endedAt: 0 };
    s.requests++; s.ctxTotal += ctx; s.maxCtx = Math.max(s.maxCtx, ctx);
    s.startedAt = Math.min(s.startedAt, r.started_at as number); s.endedAt = Math.max(s.endedAt, r.ended_at as number);
    sessions.set(sid, s);
    const bucket = Math.floor((r.ended_at as number) / 3600_000) * 3600_000;
    const h = hourly.get(bucket) ?? { t: bucket, requests: 0, ctx: 0, out: 0, cacheRead: 0 };
    h.requests++; h.ctx += ctx; h.out += r.out_tokens as number; h.cacheRead += r.cache_read as number;
    hourly.set(bucket, h);
  }
  ctxs.sort((a, b) => a - b);
  const input = t.fresh + t.cacheRead + t.cacheWrite;
  return {
    since, warnTokens: warn,
    totals: { ...t, input, cacheHitPct: input ? (t.cacheRead / input) * 100 : 0 },
    context: {
      avg: ctxs.length ? Math.round(input / ctxs.length) : 0,
      p50: pct(ctxs, 0.5), p90: pct(ctxs, 0.9), max: ctxs.length ? ctxs[ctxs.length - 1] : 0,
      overWarn, compactions,
    },
    topSessions: [...sessions.entries()]
      .map(([sessionId, s]) => ({ sessionId, ...s }))
      .sort((a, b) => b.ctxTotal - a.ctxTotal).slice(0, 5),
    hourly: [...hourly.values()].sort((a, b) => a.t - b.t),
  };
}

// ---------- housekeeping ----------
export function pruneOld(): number {
  const days = Number(getSetting("history.retentionDays"));
  if (!(days > 0)) return 0;
  const r = db.prepare("DELETE FROM requests WHERE ended_at < ?").run(Date.now() - days * 86400_000);
  return Number(r.changes);
}

export function clearAll(): number {
  return Number(db.prepare("DELETE FROM requests").run().changes);
}

/** First run: pull the existing logs/usage.jsonl into the history so it is not empty. */
export function backfillFromJsonl(): number {
  const file = path.join(ROOT, "logs", "usage.jsonl");
  const empty = (db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n === 0;
  if (!empty || !fs.existsSync(file)) return 0;
  let n = 0;
  db.exec("BEGIN");
  try {
    let i = 0;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const ended = Date.parse(j.ts);
        if (!Number.isFinite(ended)) continue;
        const dur = Number(j.durationMs ?? j.ms ?? 0);
        insert.run(
          `jsonl-${++i}`, j.sessionId ?? null, j.alias, j.provider, j.model, j.key ?? null, j.status ?? 200, 1, 0,
          j.startedAt ? Date.parse(j.startedAt) : ended - dur, j.firstTokenAt ? Date.parse(j.firstTokenAt) : null,
          ended, dur, j.ttftMs ?? null, j.in ?? 0, j.out ?? 0, j.cacheRead ?? 0, j.cacheWrite ?? 0,
          (j.in ?? 0) + (j.cacheRead ?? 0) + (j.cacheWrite ?? 0), j.cost ?? 0, j.outputTokensPerSec ?? null,
        );
        n++;
      } catch { /* skip malformed line */ }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.warn("[HISTORY] backfill failed:", (e as Error).message);
    return 0;
  }
  return n;
}
````

### `src/pricing.ts` — NEW file

````ts
import type { ModelCfg } from "./config";
import { getSetting } from "./db";

export interface Tokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * DeepSeek charges double in its peak window: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday
 * (Chinese public holidays are off-peak but are not modelled here, so this is an estimate).
 */
export function isPeakUtc(ts: number): boolean {
  const d = new Date(ts);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** USD for one request. Cache reads use price.cacheRead (falls back to the input price). */
export function costOf(price: ModelCfg["price"], u: Tokens, ts = Date.now()): number {
  if (!price) return 0;
  const base = (u.in * price.in + u.out * price.out + u.cacheRead * (price.cacheRead ?? price.in)) / 1e6;
  const mult = price.peak && isPeakUtc(ts) ? Number(getSetting("pricing.peakMultiplier")) || 1 : 1;
  return base * mult;
}
````

### Step 2 — Apply these diffs

### `src/config.ts` — adds `peak` to price, allows `auth: "none"`

````diff
--- a/src/config.ts
+++ b/src/config.ts
@@ -32,7 +32,7 @@
 export const ROUTER_KEY = process.env.ROUTER_KEY || "";
 
 // ---------- config shape ----------
-export type AuthMode = "bearer" | "x-api-key" | "both";
+export type AuthMode = "bearer" | "x-api-key" | "both" | "none";
 
 export interface ProviderCfg {
   baseURL: string;
@@ -49,7 +49,7 @@
   key?: string; // pin this model to one specific key (env var name)
   maxOutputTokens?: number;
   fallback?: string[]; // other router model names, tried in order
-  price?: { in: number; out: number; cacheRead?: number }; // USD per 1M tokens
+  price?: { in: number; out: number; cacheRead?: number; peak?: boolean }; // USD per 1M tokens; peak = provider charges more in its peak hours
 }
 
 export interface Config {
@@ -290,9 +290,9 @@
 }
 
 export function validateAuthMode(raw: unknown): AuthMode {
-  if (raw !== "bearer" && raw !== "x-api-key" && raw !== "both") {
+  if (raw !== "bearer" && raw !== "x-api-key" && raw !== "both" && raw !== "none") {
     throw new ValidationError([
-      { field: "auth", message: "must be one of: bearer, x-api-key, both" },
+      { field: "auth", message: "must be one of: bearer, x-api-key, both, none (no key, e.g. local Ollama)" },
     ]);
   }
   return raw;
@@ -360,6 +360,7 @@
   };
   const price: NonNullable<ModelCfg["price"]> = { in: num(o.in, "in"), out: num(o.out, "out") };
   if (o.cacheRead !== undefined && o.cacheRead !== "") price.cacheRead = num(o.cacheRead, "cacheRead");
+  if (o.peak === true || o.peak === "true") price.peak = true;
   if (errors.length) throw new ValidationError(errors);
   return price;
 }
````

### `src/routing.ts` — keyless providers

````diff
--- a/src/routing.ts
+++ b/src/routing.ts
@@ -21,7 +21,12 @@
 }
 
 // Sticky key choice keeps the provider-side prompt cache warm (cache is per account/key).
+/** Pseudo key name for providers that need no key (auth "none", e.g. a local Ollama). */
+export const KEYLESS_PREFIX = "(no key) ";
+export const keylessName = (provider: string): string => `${KEYLESS_PREFIX}${provider}`;
+
 export function keyOrder(p: ProviderCfg, m: ModelCfg, seed: string): string[] {
+  if (p.auth === "none") return [keylessName(m.provider)];
   if (m.key) return process.env[m.key] ? [m.key] : [];
   const names = p.keys.filter((k) => process.env[k]);
   if (!names.length) return [];
@@ -34,7 +39,7 @@
   p: ProviderCfg,
   keyName: string
 ): Record<string, string> {
-  const key = process.env[keyName] as string;
+  const key = (process.env[keyName] ?? "") as string;
   const h: Record<string, string> = {
     "content-type": "application/json",
     "anthropic-version": headerValue(req.headers["anthropic-version"]) || "2023-06-01",
````

### `src/live.ts` — history persistence hook + token counts on the final live frame

````diff
--- a/src/live.ts
+++ b/src/live.ts
@@ -181,6 +181,12 @@
   });
 }
 
+// Persistence hook (history.ts registers it; kept as a hook so live.ts has no database dependency).
+let onFinish: ((id: string, e: RecentEntry, f?: InFlight) => void) | undefined;
+export function setFinishHook(fn: (id: string, e: RecentEntry, f?: InFlight) => void): void {
+  onFinish = fn;
+}
+
 export function finishRequest(id: string, entry: Omit<RecentEntry, "ts" | "failover">): void {
   if (!id) return;
   guard("finish", () => {
@@ -188,6 +194,7 @@
     inFlight.delete(id);
     const full: RecentEntry = { ts: Date.now(), ...entry, failover: f?.failover };
     if (full.failover === undefined) delete full.failover;
+    onFinish?.(id, full, f);
     recent.push(full);
     while (recent.length > RECENT_MAX) recent.shift();
     lastUsedByProvider.set(full.provider, Date.now());
@@ -219,6 +226,13 @@
       tokensPerSec: full.outputTokensPerSec
         ?? (full.ms > 0 && full.out > 0 ? Math.round((full.out / (full.ms / 1000)) * 100) / 100 : null),
       failover: full.failover ?? null,
+      // Token counts ride the terminal frame so the UI can show a finished row without a refetch.
+      httpStatus: full.status,
+      inTokens: full.in,
+      cacheRead: full.cacheRead,
+      cacheWrite: full.cacheWrite,
+      ctxTokens: full.in + full.cacheRead + full.cacheWrite,
+      cost: full.cost,
     });
     broadcast("finish", full);
   });
````

### `src/index.ts` — auth gate, SPA fallback, history, pricing, CSP, startup

````diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -6,8 +6,11 @@
 
 import { Config, ModelCfg, PORT, ProviderCfg, ROOT, ROUTER_KEY, getCfg } from "./config";
 import { handleAdmin, hostAllowed, originAllowed } from "./admin";
+import { canWrite, handleAuthRoutes, headerKeyOk, principal, seedAdminFromEnv, userCount } from "./auth";
+import * as history from "./history";
 import * as eta from "./eta";
 import * as live from "./live";
+import { costOf } from "./pricing";
 import { buildBody, buildHeaders, keyOrder, resolveAlias } from "./routing";
 
 if (!ROUTER_KEY) {
@@ -21,6 +24,9 @@
 const totals = new Map<string, UsageTotals & { requests: number; cost: number }>();
 fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
 
+// Persist every finished request (success, failure, abort) to the SQLite history.
+live.setFinishHook(history.recordFinished);
+
 // ---------- helpers ----------
 function sendJSON(res: ServerResponse, status: number, data: unknown): void {
   if (res.headersSent) return;
@@ -44,17 +50,11 @@
   return x.length === y.length && crypto.timingSafeEqual(x, y);
 }
 
-function authed(req: IncomingMessage): boolean {
-  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
-  const xk = String(req.headers["x-api-key"] ?? "");
-  if (safeEq(bearer, ROUTER_KEY) || safeEq(xk, ROUTER_KEY)) return true;
-  // EventSource cannot send headers, so the live stream (and only it) may pass ?key=.
-  if (req.method === "GET") {
-    const u = new URL(req.url ?? "/", "http://localhost");
-    if (u.pathname === "/admin/events")
-      return safeEq(u.searchParams.get("key") ?? "", ROUTER_KEY);
-  }
-  return false;
+/** Legacy machine credential for the live stream: EventSource cannot set headers, so scripts may pass ?key=. */
+function sseKeyOk(req: IncomingMessage): boolean {
+  if (req.method !== "GET") return false;
+  const u = new URL(req.url ?? "/", "http://localhost");
+  return u.pathname === "/admin/events" && safeEq(u.searchParams.get("key") ?? "", ROUTER_KEY);
 }
 
 function mergeUsage(u: UsageTotals, x: any): void {
@@ -105,8 +105,7 @@
 function record(
   alias: string, m: ModelCfg, keyName: string, u: UsageTotals, status: number, ms: number, timing?: Timing
 ): void {
-  const p = m.price;
-  const cost = p ? (u.in * p.in + u.out * p.out + u.cacheRead * (p.cacheRead ?? p.in)) / 1e6 : 0;
+  const cost = costOf(m.price, u);
   const t = totals.get(alias) ?? { ...ZERO(), requests: 0, cost: 0 };
   t.requests++; t.in += u.in; t.out += u.out; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; t.cost += cost;
   totals.set(alias, t);
@@ -219,7 +218,7 @@
     if (track) {
       live.finishRequest(track.id, {
         alias, provider: m.provider, model: m.model, key: keyName, status: up.status,
-        ms: durationMs, ...u, cost: costOf(m, u),
+        ms: durationMs, ...u, cost: costOf(m.price, u),
         sessionId: track.sessionId ?? null, startedAt: started,
         firstTokenAt: timing.firstTokenAt, ttftMs, durationMs, outputTokensPerSec,
       });
@@ -237,12 +236,6 @@
   }
 }
 
-function costOf(m: ModelCfg, u: UsageTotals): number {
-  const p = m.price;
-  if (!p) return 0;
-  return (u.in * p.in + u.out * p.out + u.cacheRead * (p.cacheRead ?? p.in)) / 1e6;
-}
-
 async function proxyMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
   const started = Date.now();
   const raw = await readBody(req);
@@ -381,7 +374,7 @@
     "content-type": "text/html; charset=utf-8",
     "cache-control": "no-store",
     "content-security-policy":
-      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
+      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'none'; base-uri 'none'",
   });
   res.end(html);
 }
@@ -420,8 +413,13 @@
 
     if (req.method === "GET" && p === "/health") return sendJSON(res, 200, { status: "ok" });
 
-    // UI shell: no secrets inside it, so it loads before the key prompt.
-    if (req.method === "GET" && (p === "/ui" || p === "/ui/index.html")) {
+    if (req.method === "GET" && p === "/") {
+      res.writeHead(302, { location: "/ui/live" });
+      return void res.end();
+    }
+
+    // UI shell (no secrets inside): every /ui/* path is a client-side route, so a refresh keeps the page.
+    if (req.method === "GET" && (p === "/ui" || p.startsWith("/ui/"))) {
       if (!hostAllowed(req)) return fail(res, 403, "forbidden_error", "Host header not allowed");
       return serveUI(res);
     }
@@ -433,12 +431,22 @@
       return fail(res, 404, "not_found_error", "Not found");
     }
 
-    if (!authed(req)) return fail(res, 401, "authentication_error", "Invalid router key");
+    // Sign-in, first-run setup and user management (own auth checks inside).
+    if (await handleAuthRoutes(req, res, p, ROUTER_KEY, { hostOk: hostAllowed(req), originOk: originAllowed(req) })) return;
+
+    const isAdminPath = p === "/admin" || p.startsWith("/admin/");
+    // /v1/* stays header-key only (Claude Code). /admin/* also accepts a signed-in browser session.
+    const who = isAdminPath ? principal(req, ROUTER_KEY) ?? (sseKeyOk(req) ? ({ kind: "key" } as const) : null)
+                            : headerKeyOk(req, ROUTER_KEY) ? ({ kind: "key" } as const) : null;
+    if (!who) return fail(res, 401, "authentication_error", isAdminPath ? "Sign in required" : "Invalid router key");
     if (!hostAllowed(req)) return fail(res, 403, "forbidden_error", "Host header not allowed");
     const stateChanging = req.method !== "GET" && req.method !== "HEAD";
     if (stateChanging && !originAllowed(req)) {
       return fail(res, 403, "forbidden_error", "Cross-origin request refused");
     }
+    if (isAdminPath && stateChanging && !canWrite(who)) {
+      return fail(res, 403, "forbidden_error", "Read-only account: ask an admin to make this change");
+    }
 
     if (p === "/admin/status") {
       const c = getCfg();
@@ -492,6 +500,13 @@
 // The rings are seeded before the port opens: a request in the first moments
 // after restart must not get etaMs=null ("estimating...") against a populated
 // usage log. An unreadable log degrades to empty history, not a crash.
+seedAdminFromEnv();
+{
+  const n = history.backfillFromJsonl();
+  if (n) console.log(`[HISTORY] imported ${n} requests from logs/usage.jsonl`);
+  history.pruneOld();
+  setInterval(() => history.pruneOld(), 6 * 3600_000).unref();
+}
 eta.seedHistory()
   .catch((e) => console.warn("[ETA] usage log unreadable -> seeding with empty history:",
     e instanceof Error ? e.message : String(e)))
@@ -504,6 +519,6 @@
         const ok = !p ? "NO PROVIDER" : p.disabled ? "DISABLED" : keyOrder(p, m, "x").length ? "ok" : "NO KEY";
         console.log(`  ${name.padEnd(10)} ${m.provider}/${m.model}  [${ok}]`);
       }
-      console.log(`\n  UI (needs ROUTER_KEY):  http://127.0.0.1:${PORT}/ui\n`);
+      console.log(`\n  UI:  http://127.0.0.1:${PORT}/ui  ${userCount() === 0 ? "(open it to create the first admin account)" : "(sign in)"}\n`);
     });
   });
````

### `src/admin.ts` — provider create with keys, .env key discovery/attach, history, insights, settings, system

````diff
--- a/src/admin.ts
+++ b/src/admin.ts
@@ -6,9 +6,12 @@
 import {
   BACKUP_DIR, Config, ENV_FILE, ModelCfg, PORT, ProviderCfg, ROUTES_FILE,
   StaleVersionError, ValidationError, commitConfig, commitEnv, configVersion, envVersion,
-  getCfg, validateEnvName, validateModelAlias, validateModelBody, validateNoCycle,
+  getCfg, readEnvText, validateEnvName, validateModelAlias, validateModelBody, validateNoCycle,
   validateProviderBody, validateProviderName,
 } from "./config";
+import { DATA_DIR, DB_FILE, SETTING_DEFAULTS, allSettings, db, setSetting } from "./db";
+import { userCount } from "./auth";
+import * as history from "./history";
 import {
   MAX_SSE_CLIENTS, RECENT_MAX, addClient, cooldownLeft, dropClient, inFlight,
   lastUsedKey, lastUsedProvider, providerRollup, recent, resetCooldown, rollup, sseClientCount,
@@ -105,8 +108,10 @@
 }
 
 function providerView(name: string, p: ProviderCfg) {
+  const keyless = p.auth === "none";
   const keys = p.keys.map(keyView);
   return {
+    keyless,
     name,
     baseURL: p.baseURL,
     auth: p.auth,
@@ -114,8 +119,8 @@
     dropBodyFields: p.dropBodyFields ?? [],
     disabled: !!p.disabled,
     keys,
-    keysTotal: keys.length,
-    keysHealthy: keys.filter((k) => k.configured && !k.cooling).length,
+    keysTotal: keyless ? 1 : keys.length,
+    keysHealthy: keyless ? 1 : keys.filter((k) => k.configured && !k.cooling).length,
     models: Object.keys(getCfg().models).filter((a) => getCfg().models[a].provider === name),
     lastUsed: lastUsedProvider(name),
     last5m: providerRollup(name, 5),
@@ -124,6 +129,7 @@
 
 function modelView(alias: string, m: ModelCfg) {
   const p = getCfg().providers[m.provider];
+  const keyless = p?.auth === "none";
   const keys = m.key ? [keyView(m.key)] : (p?.keys ?? []).map(keyView);
   return {
     alias,
@@ -132,8 +138,8 @@
     price: m.price ?? null,
     providerMissing: !p,
     providerDisabled: !!p?.disabled,
-    keysHealthy: keys.filter((k) => k.configured && !k.cooling).length,
-    keysTotal: keys.length,
+    keysHealthy: keyless ? 1 : keys.filter((k) => k.configured && !k.cooling).length,
+    keysTotal: keyless ? 1 : keys.length,
     lastUsed: lastUsedProvider(m.provider),
   };
 }
@@ -483,9 +489,49 @@
   if (c.providers[name]) throw new ValidationError([{ field: "name", message: `"${name}" already exists` }]);
   const version = expectVersion(body);
   const cfg = validateProviderBody(body);
-  const next: Config = { ...c, providers: { ...c.providers, [name]: { ...cfg, keys: [] } } };
+
+  // Keys can be given right here: { envName?, value? } rows. A row with a value is written to .env;
+  // a row with only an envName attaches a variable that already exists in .env.
+  const rawKeys = body.keys === undefined ? [] : body.keys;
+  if (!Array.isArray(rawKeys)) throw new ValidationError([{ field: "keys", message: "must be a list" }]);
+  if (cfg.auth === "none" && rawKeys.length) {
+    throw new ValidationError([{ field: "keys", message: 'must be empty when auth is "none" (no key needed)' }]);
+  }
+  const taken = new Map<string, string>();
+  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) taken.set(k, pn);
+  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
+  const keys: string[] = [];
+  const setEnv: Record<string, string> = {};
+  const errors: { field: string; message: string }[] = [];
+  rawKeys.forEach((row: unknown, i: number) => {
+    const r = (row ?? {}) as Record<string, unknown>;
+    const value = typeof r.value === "string" ? r.value.trim() : "";
+    let envName = typeof r.envName === "string" && r.envName.trim() ? r.envName.trim() : "";
+    if (!envName) {
+      let n = 1;
+      while (taken.has(`${base}_KEY_${n}`) || keys.includes(`${base}_KEY_${n}`)) n++;
+      envName = `${base}_KEY_${n}`;
+    }
+    try { validateEnvName(envName, `keys.${i}.envName`); } catch (e) { errors.push(...(e as ValidationError).errors); return; }
+    if (taken.has(envName) || keys.includes(envName)) {
+      errors.push({ field: `keys.${i}.envName`, message: `"${envName}" is already used${taken.has(envName) ? ` by provider "${taken.get(envName)}"` : " in this list"}` });
+      return;
+    }
+    if (value && value.length < 4) { errors.push({ field: `keys.${i}.value`, message: "must be at least 4 characters" }); return; }
+    if (!value && !envNamesInFile().has(envName)) {
+      errors.push({ field: `keys.${i}.value`, message: `is required (there is no ${envName} in .env to attach)` });
+      return;
+    }
+    keys.push(envName);
+    if (value) setEnv[envName] = value;
+  });
+  if (errors.length) throw new ValidationError(errors);
+
+  const next: Config = { ...c, providers: { ...c.providers, [name]: { ...cfg, keys } } };
   commit(next, version);
-  sendJSON(res, 201, { version: configVersion(), provider: providerView(name, next.providers[name]) });
+  if (Object.keys(setEnv).length) commitEnv(setEnv, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
+  for (const k of keys) resetCooldown(k);
+  sendJSON(res, 201, { version: configVersion(), envVersion: envVersion(), provider: providerView(name, getCfg().providers[name]) });
 });
 
 on("GET", /^\/admin\/providers\/([^/]+)$/, (_req, res, [name]) => {
@@ -892,6 +938,157 @@
 });
 
 // ---- entry point used by index.ts ----
+
+// ---------- .env key discovery ----------
+/** Variable NAMES defined in the .env file (never values, never the process environment). */
+function envNamesInFile(): Set<string> {
+  const out = new Set<string>();
+  for (const line of readEnvText().split(/\r?\n/)) {
+    const t = line.trim();
+    if (!t || t.startsWith("#")) continue;
+    const i = t.indexOf("=");
+    if (i > 0) out.add(t.slice(0, i).trim());
+  }
+  return out;
+}
+
+const SECRETISH = /(^|_)(KEY|TOKEN|SECRET)(_|$)/i;
+const NOT_PROVIDER_KEYS = new Set(["ROUTER_KEY", "ADMIN_PASSWORD"]);
+
+on("GET", /^\/admin\/env\/keys$/, (req, res) => {
+  const c = getCfg();
+  const attached = new Map<string, string>();
+  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) attached.set(k, pn);
+  const wanted = new URL(req.url ?? "/", "http://localhost").searchParams.get("provider") ?? "";
+  const wantedBase = wanted.toUpperCase().replace(/[^A-Z0-9]/g, "_");
+  const names = [...envNamesInFile()].filter((n) => SECRETISH.test(n) && !NOT_PROVIDER_KEYS.has(n));
+  const keys = names.map((envName) => {
+    const v = process.env[envName] ?? "";
+    const suggested = Object.keys(c.providers).find((pn) => envName.startsWith(`${pn.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`)) ?? null;
+    return {
+      envName, configured: !!v, last4: v ? v.slice(-4) : "",
+      attachedTo: attached.get(envName) ?? null, suggestedProvider: suggested,
+    };
+  });
+  sendJSON(res, 200, {
+    envVersion: envVersion(),
+    keys: wanted ? keys.filter((k) => !k.attachedTo && (k.suggestedProvider === wanted || envNameMatches(k.envName, wantedBase))) : keys,
+  });
+});
+const envNameMatches = (envName: string, base: string): boolean => !!base && envName.startsWith(`${base}_`);
+
+on("POST", /^\/admin\/providers\/([^/]+)\/keys\/attach$/, async (req, res, [name]) => {
+  const body = await readJSONBody(req);
+  const c = getCfg();
+  const p = c.providers[name];
+  if (!p) return fail(res, 404, "not_found_error", `No provider "${name}"`);
+  const version = expectVersion(body);
+  const list = Array.isArray(body.envNames) ? body.envNames : [];
+  if (!list.length) throw new ValidationError([{ field: "envNames", message: "must be a non-empty list" }]);
+  const inFile = envNamesInFile();
+  const owner = new Map<string, string>();
+  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) owner.set(k, pn);
+  const errors: { field: string; message: string }[] = [];
+  const add: string[] = [];
+  list.forEach((raw: unknown, i: number) => {
+    let n: string;
+    try { n = validateEnvName(raw, `envNames.${i}`); } catch (e) { errors.push(...(e as ValidationError).errors); return; }
+    if (!inFile.has(n)) errors.push({ field: `envNames.${i}`, message: `${n} is not defined in .env` });
+    else if (owner.has(n) && owner.get(n) !== name) errors.push({ field: `envNames.${i}`, message: `${n} already belongs to provider "${owner.get(n)}"` });
+    else if (!p.keys.includes(n) && !add.includes(n)) add.push(n);
+  });
+  if (errors.length) throw new ValidationError(errors);
+  const next: Config = { ...c, providers: { ...c.providers, [name]: { ...p, keys: [...p.keys, ...add] } } };
+  commit(next, version);
+  sendJSON(res, 200, { version: configVersion(), attached: add, provider: providerView(name, getCfg().providers[name]) });
+});
+
+// ---------- request history + token insights ----------
+const RANGE_MS: Record<string, number> = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3, all: 3650 * 86400e3 };
+
+on("GET", /^\/admin\/requests$/, (req, res) => {
+  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
+  const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
+  const status = q.get("status");
+  const out = history.listRequests({
+    limit: num("limit"), before: num("before"),
+    status: status === "ok" || status === "error" ? status : undefined,
+    alias: q.get("alias") || undefined, provider: q.get("provider") || undefined,
+    q: q.get("q") || undefined, minCtx: num("minCtx"),
+  });
+  sendJSON(res, 200, {
+    ...out,
+    running: [...inFlight.values()].map((f) => ({
+      id: f.id, alias: f.alias, provider: f.provider, model: f.model, key: f.keyName, startedAt: f.startedAt,
+      stream: f.stream, status: f.status, failover: !!f.failover, outSoFar: f.outSoFar ?? 0, tokensPerSec: f.tokensPerSec ?? null,
+    })),
+  });
+});
+
+on("POST", /^\/admin\/requests\/clear$/, (_req, res) => {
+  sendJSON(res, 200, { deleted: history.clearAll() });
+});
+
+on("GET", /^\/admin\/insights$/, (req, res) => {
+  const range = new URL(req.url ?? "/", "http://localhost").searchParams.get("range") ?? "24h";
+  if (!(range in RANGE_MS)) throw new ValidationError([{ field: "range", message: `must be one of ${Object.keys(RANGE_MS).join(", ")}` }]);
+  sendJSON(res, 200, { range, ...history.insights(RANGE_MS[range]) });
+});
+
+// ---------- app settings (SQLite) + system information ----------
+on("GET", /^\/admin\/app-settings$/, (_req, res) => sendJSON(res, 200, { settings: allSettings() }));
+
+on("PUT", /^\/admin\/app-settings$/, async (req, res) => {
+  const body = await readJSONBody(req);
+  const input = (body.settings ?? {}) as Record<string, unknown>;
+  const errors: { field: string; message: string }[] = [];
+  const clean: Record<string, unknown> = {};
+  const int = (k: string, lo: number, hi: number) => {
+    const n = Number(input[k]);
+    if (!Number.isInteger(n) || n < lo || n > hi) errors.push({ field: k, message: `must be a whole number from ${lo} to ${hi}` });
+    else clean[k] = n;
+  };
+  for (const k of Object.keys(input)) {
+    if (!(k in SETTING_DEFAULTS)) { errors.push({ field: k, message: "unknown setting" }); continue; }
+    if (k === "history.retentionDays") int(k, 0, 3650);
+    else if (k === "context.warnTokens") int(k, 10_000, 2_000_000);
+    else if (k === "pricing.peakMultiplier") {
+      const n = Number(input[k]);
+      if (!Number.isFinite(n) || n < 1 || n > 10) errors.push({ field: k, message: "must be a number from 1 to 10" }); else clean[k] = n;
+    } else if (k === "ui.projectName") {
+      const v = String(input[k] ?? "").trim();
+      if (!v || v.length > 40) errors.push({ field: k, message: "must be 1-40 characters" }); else clean[k] = v;
+    }
+  }
+  if (errors.length) throw new ValidationError(errors);
+  for (const [k, v] of Object.entries(clean)) setSetting(k, v);
+  if ("history.retentionDays" in clean) history.pruneOld();
+  sendJSON(res, 200, { settings: allSettings() });
+});
+
+const startedAt = Date.now();
+on("GET", /^\/admin\/system$/, (_req, res) => {
+  const c = getCfg();
+  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
+  const oldest = db.prepare("SELECT MIN(ended_at) AS t FROM requests").get() as { t: number | null };
+  let dbBytes = 0;
+  try { dbBytes = fs.statSync(DB_FILE).size; } catch { /* not yet created */ }
+  let logBytes = 0;
+  try { logBytes = fs.statSync(LOG_FILE).size; } catch { /* no log yet */ }
+  let version = "";
+  try { version = JSON.parse(fs.readFileSync(path.join(process.env.ROUTER_HOME ?? path.resolve(__dirname, ".."), "package.json"), "utf8")).version; } catch { /* ignore */ }
+  sendJSON(res, 200, {
+    version, node: process.version, platform: `${process.platform}/${process.arch}`, pid: process.pid,
+    uptimeSec: Math.round((Date.now() - startedAt) / 1000), port: PORT,
+    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, memoryMb: Math.round(process.memoryUsage().rss / 1048576),
+    paths: { routes: ROUTES_FILE, env: ENV_FILE, backups: BACKUP_DIR, database: DB_FILE, dataDir: DATA_DIR, usageLog: LOG_FILE },
+    database: { bytes: dbBytes, requests: count("SELECT COUNT(*) AS n FROM requests"), oldestRequestAt: oldest.t, users: userCount() },
+    usageLogBytes: logBytes,
+    counts: { providers: Object.keys(c.providers).length, models: Object.keys(c.models).length },
+    sseClients: sseClientCount(),
+  });
+});
+
 export async function handleAdmin(
   req: IncomingMessage,
   res: ServerResponse,
````

### Step 3 — Small config edits (by hand)

1. `package.json` (repo root): add `"engines": { "node": ">=22.13" }` after `devDependencies`. (`node:sqlite` needs Node 22.13+; you run 24.)
2. `.gitignore`: append a line `data/` (the database must never be committed).
3. `.env.example`: replace the comment line `# The UI lives at http://127.0.0.1:21450/ui - paste ROUTER_KEY when prompted.` with:
   ```
   # The UI lives at http://127.0.0.1:21450/ui. The first visit asks you to create the admin account;
   # after that you sign in with a username and password. ROUTER_KEY is only for Claude Code and scripts.
   # Headless install? Uncomment both to create the first admin at startup, then delete the password line.
   # ADMIN_USER=admin
   # ADMIN_PASSWORD=change-me-please
   ```

## Verify

```bash
npx tsc --noEmit                 # expect: no output
node scripts/smoke.mjs           # expect: ALL PASSED  (12 checks)
node scripts/admin-smoke.mjs     # expect: ALL PASSED  (170+ checks)
```
What I ran on exactly this code before writing this prompt (sandbox copy of your project, your real `routes.json` and `usage.jsonl`): `tsc` clean; both smoke suites pass; ~45 HTTP checks — first-run setup, second setup refused (409), wrong login 401, 6th failed login 429, read-only user gets 403 on writes, cross-origin POST refused, last-admin protection, disabled user's session dies, keyless provider routes with **no** auth header upstream, `.env` discovery/attach (`OPENCODE_KEY_2/3` attached, unknown names refused), provider created with two keys (values written to `.env`, never returned by any endpoint), history imported 530 rows, `insights` reports p50 105,695 / p90 155,966 / max 167,902 tokens, 10 compactions, 98.95% cache hit.

Do **not** restart the router yet if the web steps (02–03) are still pending; restart once at the end.
