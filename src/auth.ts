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
