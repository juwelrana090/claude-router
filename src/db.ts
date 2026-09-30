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
  // 2: context guard memory + per-request guard numbers
  `CREATE TABLE guard_cleared (
     session_id TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     chars INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, tool_use_id)
   );
   CREATE INDEX idx_guard_created ON guard_cleared(created_at);
   ALTER TABLE requests ADD COLUMN guard_saved INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE requests ADD COLUMN guard_would INTEGER NOT NULL DEFAULT 0;`,
  // 3: routing visibility (what was asked, how it resolved, every route tried)
  `ALTER TABLE requests ADD COLUMN asked_alias TEXT;
   ALTER TABLE requests ADD COLUMN requested_model TEXT;
   ALTER TABLE requests ADD COLUMN resolved_via TEXT;
   ALTER TABLE requests ADD COLUMN trace TEXT;`,
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
  "guard.mode": "shadow",
  "guard.highTokens": 90_000,
  "guard.lowTokens": 45_000,
  "guard.keepRecent": 6,
  "guard.minChars": 1200,
  "routing.failover": "auto",
  "routing.retries": 2,
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
