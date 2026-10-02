import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = process.env.ROUTER_HOME ?? path.resolve(__dirname, "..");

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

export const PORT = Number(process.env.ROUTER_PORT || 21450);
export const ROUTER_KEY = process.env.ROUTER_KEY || "";

/**
 * External origins allowed to reach the router through a reverse proxy on your own domain
 * (comma-separated, e.g. "https://ai.qawiun.com"). Each entry is added to the Host and the
 * Origin guards in admin.ts; loopback-only is the default when this is unset.
 */
export const EXTRA_ORIGINS: { origin: string; host: string }[] = String(process.env.ROUTER_EXTRA_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean)
  .map((s) => {
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      return { origin: u.origin, host: u.hostname + (u.port ? `:${u.port}` : "") };
    } catch {
      return null;
    }
  })
  .filter((x): x is { origin: string; host: string } => x !== null);

// ---------- config shape ----------
export type AuthMode = "bearer" | "x-api-key" | "both" | "none";

export type Protocol = "anthropic" | "openai";

export interface ProviderCfg {
  baseURL: string;
  /** anthropic (default): the provider speaks Claude's Messages API. openai: it speaks chat completions and the router converts. */
  protocol?: Protocol;
  auth: AuthMode;
  keys: string[]; // env var NAMES, not the secrets
  dropBeta?: boolean;
  dropBodyFields?: string[];
  disabled?: boolean;
  /** Optional daily caps, counted from the request history since local midnight. Unset = unlimited. */
  dailyRequests?: number;
  dailyTokens?: number; // fresh input + cache read + cache write + output
}

export interface ModelCfg {
  provider: string;
  model: string;
  key?: string; // pin this model to one specific key (env var name)
  maxOutputTokens?: number;
  contextWindow?: number; // the model's real context window in tokens; bigger prompts are trimmed or the route is skipped
  fallback?: string[]; // other router model names, tried in order
  price?: { in: number; out: number; cacheRead?: number; peak?: boolean }; // USD per 1M tokens; peak = provider charges more in its peak hours
}

export interface Config {
  _note?: string;
  defaultModel?: string;
  aliases?: Record<string, string>;
  providers: Record<string, ProviderCfg>;
  models: Record<string, ModelCfg>;
}

export const ROUTES_FILE = path.join(ROOT, process.env.ROUTES_FILE ?? "routes.json");
export const ENV_FILE = path.join(ROOT, ".env");
export const BACKUP_DIR = path.join(ROOT, "backups");

let cfg: Config | undefined;
let cfgMtime = 0;
let cfgVersion = "";

function hash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

// Hot reload by mtime. `version` is a content hash so the UI can do optimistic
// concurrency (PUT/DELETE send it back, server answers 409 when it moved on).
export function getCfg(): Config {
  try {
    const m = fs.statSync(ROUTES_FILE).mtimeMs;
    if (!cfg || m !== cfgMtime) {
      const text = fs.readFileSync(ROUTES_FILE, "utf8");
      cfg = JSON.parse(text) as Config;
      cfgMtime = m;
      cfgVersion = hash(text);
      if (cfg) console.log(`[ROUTER] routes loaded (${Object.keys(cfg.models).length} models)`);
    }
  } catch (e) {
    if (!cfg) throw e;
    console.warn("[ROUTER] routes.json invalid, keeping previous config:", (e as Error).message);
  }
  return cfg as Config;
}

export function configVersion(): string {
  getCfg();
  return cfgVersion;
}

// Force the next getCfg() to re-read (called right after an admin write).
export function invalidate(): void {
  cfg = undefined;
  cfgMtime = 0;
}

// ---------- atomic writes + backups ----------
export function atomicWrite(file: string, data: string, mode = 0o600): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(dir, "r");
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
  } catch {
    /* directory fsync is best effort (not supported everywhere) */
  }
}

const BACKUP_KEEP = 5;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Timestamped copy in backups/, keeping only the newest BACKUP_KEEP.
export function backup(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const prefix = path.basename(file) + "-";
  const dest = path.join(BACKUP_DIR, `${prefix}${stamp()}.bak`);
  fs.copyFileSync(file, dest);
  const old = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".bak"))
    .sort();
  while (old.length > BACKUP_KEEP) {
    const drop = old.shift();
    if (drop) fs.rmSync(path.join(BACKUP_DIR, drop), { force: true });
  }
  return dest;
}

export function serializeConfig(c: Config): string {
  return JSON.stringify(c, null, 2) + "\n";
}

// Write routes.json atomically after backing it up. Returns false on a stale version.
export function commitConfig(next: Config, expectedVersion?: string): void {
  const current = configVersion();
  if (expectedVersion !== undefined && expectedVersion !== current) {
    throw new StaleVersionError(current);
  }
  backup(ROUTES_FILE);
  atomicWrite(ROUTES_FILE, serializeConfig(next));
  invalidate();
}

// ---------- .env editing (secrets only ever live here, never in routes.json) ----------
export function readEnvText(): string {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
}

export function envVersion(): string {
  return hash(readEnvText());
}

export class StaleVersionError extends Error {
  current: string;
  constructor(current: string) {
    super("config changed since you loaded it");
    this.current = current;
  }
}

function envLine(name: string, value: string): string {
  const needsQuote = /[\s#"'$]/.test(value);
  const v = needsQuote ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
  return `${name}=${v}`;
}

function envNameOf(line: string): string | undefined {
  const t = line.trim();
  if (!t || t.startsWith("#")) return undefined;
  const i = t.indexOf("=");
  return i === -1 ? undefined : t.slice(0, i).trim();
}

/**
 * Set and/or remove env vars in .env and apply them to process.env immediately,
 * so a freshly added key works on the very next request without a restart.
 */
export function commitEnv(
  set: Record<string, string>,
  remove: string[] = [],
  expectedEnvVersion?: string
): void {
  if (expectedEnvVersion !== undefined && expectedEnvVersion !== envVersion()) {
    throw new StaleVersionError(envVersion());
  }
  const lines = readEnvText().split(/\r?\n/);
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();

  const drop = new Set(remove);
  const out: string[] = [];
  for (const line of lines) {
    const n = envNameOf(line);
    if (n !== undefined && drop.has(n)) continue; // remove the line entirely
    if (n !== undefined && Object.prototype.hasOwnProperty.call(set, n)) {
      out.push(envLine(n, set[n])); // replace in place, keeps ordering stable
      delete set[n];
      continue;
    }
    out.push(line);
  }
  for (const [n, v] of Object.entries(set)) out.push(envLine(n, v));

  const text = out.join("\n") + (out.length ? "\n" : "");
  backup(ENV_FILE);
  atomicWrite(ENV_FILE, text);

  for (const n of remove) delete process.env[n];
  for (const [n, v] of Object.entries(set)) process.env[n] = v;
}

// ---------- validation ----------
export interface FieldError {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join("; "));
    this.errors = errors;
  }
}

export const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ENVNAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const MODEL_ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const RESERVED_ALIASES = ["opus", "sonnet", "haiku"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function validateBaseURL(raw: unknown, field = "baseURL"): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ValidationError([{ field, message: "is required" }]);
  const value = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ValidationError([{ field, message: "must be a valid URL" }]);
  }
  if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname)) {
    throw new ValidationError([
      { field, message: "must use https (http is only allowed for localhost)" },
    ]);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ValidationError([{ field, message: "must be an http(s) URL" }]);
  }
  return value;
}

export function validateProviderName(raw: unknown): string {
  if (typeof raw !== "string" || !PROVIDER_RE.test(raw)) {
    throw new ValidationError([
      { field: "name", message: "must match /^[a-z0-9][a-z0-9-]{0,31}$/" },
    ]);
  }
  return raw;
}

export function validateEnvName(raw: unknown, field = "envName"): string {
  if (typeof raw !== "string" || !ENVNAME_RE.test(raw)) {
    throw new ValidationError([
      { field, message: "must match /^[A-Z][A-Z0-9_]{1,63}$/ (env var name, not the key)" },
    ]);
  }
  return raw;
}

export function validateAuthMode(raw: unknown): AuthMode {
  if (raw !== "bearer" && raw !== "x-api-key" && raw !== "both" && raw !== "none") {
    throw new ValidationError([
      { field: "auth", message: "must be one of: bearer, x-api-key, both, none (no key, e.g. local Ollama)" },
    ]);
  }
  return raw;
}

/** Catches the classic address mistakes before they turn into a 404. Returns a message or null. */
export function baseURLProblem(baseURL: string, protocol: Protocol): string | null {
  let u: URL;
  try { u = new URL(baseURL); } catch { return null; }
  const path = u.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(path)) {
    const fixed = `${u.origin}${path.replace(/\/chat\/completions$/, "")}`;
    return `remove /chat/completions from the end and set "Provider speaks" to OpenAI style: use ${fixed} (the router adds the final part itself)`;
  }
  if (/\/v1\/messages$/.test(path)) {
    const fixed = `${u.origin}${path.replace(/\/v1\/messages$/, "")}`;
    return `remove /v1/messages from the end: use ${fixed} (the router adds the final part itself)`;
  }
  if (protocol === "anthropic" && /\/v1$/.test(path)) {
    return "remove /v1 from the end: for an Anthropic-style provider the router adds /v1/messages itself";
  }
  if (u.hostname === "ollama.com" && path === "/api") {
    return "Ollama cloud's Anthropic-style address is https://ollama.com (without /api); /api only serves Ollama's own format";
  }
  return null;
}

export function validateProviderBody(body: Record<string, unknown>, existing?: ProviderCfg): ProviderCfg {
  const errors: FieldError[] = [];
  let baseURL = existing?.baseURL ?? "";
  let auth = existing?.auth ?? "bearer";
  try {
    baseURL = validateBaseURL(body.baseURL ?? existing?.baseURL);
  } catch (e) {
    errors.push(...(e as ValidationError).errors);
  }
  try {
    auth = validateAuthMode(body.auth ?? existing?.auth ?? "bearer");
  } catch (e) {
    errors.push(...(e as ValidationError).errors);
  }

  let dropBodyFields = existing?.dropBodyFields;
  if (body.dropBodyFields !== undefined) {
    if (!Array.isArray(body.dropBodyFields) || body.dropBodyFields.some((f) => typeof f !== "string")) {
      errors.push({ field: "dropBodyFields", message: "must be a list of body field names" });
    } else {
      dropBodyFields = body.dropBodyFields.map((f: string) => f.trim()).filter(Boolean);
    }
  }

  let protocol: Protocol = existing?.protocol ?? "anthropic";
  if (body.protocol !== undefined) {
    if (body.protocol !== "anthropic" && body.protocol !== "openai") {
      errors.push({ field: "protocol", message: "must be anthropic or openai" });
    } else protocol = body.protocol;
  }
  {
    const problem = baseURL ? baseURLProblem(baseURL, protocol) : null;
    if (problem) errors.push({ field: "baseURL", message: problem });
  }

  const dropBeta =
    body.dropBeta === undefined ? !!existing?.dropBeta : body.dropBeta === true || body.dropBeta === "true";
  const disabled =
    body.disabled === undefined ? !!existing?.disabled : body.disabled === true || body.disabled === "true";

  const limit = (field: "dailyRequests" | "dailyTokens", lo: number, hi: number): number | undefined => {
    const raw = body[field];
    if (raw === undefined) return existing?.[field];
    if (raw === null || raw === "") return undefined; // explicit clear
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isInteger(n) || n < lo || n > hi) {
      errors.push({ field, message: `must be a whole number from ${lo} to ${hi} (leave empty for no limit)` });
      return existing?.[field];
    }
    return n;
  };
  const dailyRequests = limit("dailyRequests", 1, 100_000_000);
  const dailyTokens = limit("dailyTokens", 10_000, 1_000_000_000_000);

  if (errors.length) throw new ValidationError(errors);
const out: ProviderCfg = { baseURL, auth, keys: existing?.keys ?? [], dropBeta, dropBodyFields, disabled };
  if (protocol === "openai") out.protocol = "openai";
  if (dailyRequests !== undefined) out.dailyRequests = dailyRequests;
  if (dailyTokens !== undefined) out.dailyTokens = dailyTokens;
  return out;
}

export function validateModelAlias(raw: unknown): string {
  if (typeof raw !== "string" || !MODEL_ALIAS_RE.test(raw)) {
    throw new ValidationError([
      { field: "alias", message: "must match /^[a-z0-9][a-z0-9._-]{0,63}$/" },
    ]);
  }
  if (RESERVED_ALIASES.includes(raw)) {
    throw new ValidationError([
      { field: "alias", message: `"${raw}" is reserved for the Claude Code alias mapping` },
    ]);
  }
  return raw;
}

export function validatePrice(raw: unknown, field = "price"): ModelCfg["price"] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "object") throw new ValidationError([{ field, message: "must be {in, out, cacheRead?}" }]);
  const o = raw as Record<string, unknown>;
  const errors: FieldError[] = [];
  const num = (v: unknown, f: string): number => {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      errors.push({ field: `${field}.${f}`, message: "must be a number >= 0 (USD per 1M tokens)" });
      return 0;
    }
    return n;
  };
  const price: NonNullable<ModelCfg["price"]> = { in: num(o.in, "in"), out: num(o.out, "out") };
  if (o.cacheRead !== undefined && o.cacheRead !== "") price.cacheRead = num(o.cacheRead, "cacheRead");
  if (o.peak === true || o.peak === "true") price.peak = true;
  if (errors.length) throw new ValidationError(errors);
  return price;
}

export function validateModelBody(
  body: Record<string, unknown>,
  c: Config,
  existing?: ModelCfg
): ModelCfg {
  const errors: FieldError[] = [];

  const provider =
    body.provider === undefined ? existing?.provider : (body.provider as unknown as string);
  if (typeof provider !== "string" || !c.providers[provider]) {
    errors.push({
      field: "provider",
      message:
        typeof provider === "string" && provider
          ? `unknown provider "${provider}" (known: ${Object.keys(c.providers).join(", ") || "none"})`
          : "is required",
    });
  }

  const model = body.model === undefined ? existing?.model : (body.model as unknown as string);
  if (typeof model !== "string" || !model.trim()) {
    errors.push({ field: "model", message: "is required (the upstream model string)" });
  }

  let maxOutputTokens = existing?.maxOutputTokens;
  if (body.maxOutputTokens === null) {
    maxOutputTokens = undefined; // explicit clear
  } else if (body.maxOutputTokens !== undefined && body.maxOutputTokens !== "") {
    const n = typeof body.maxOutputTokens === "string" ? Number(body.maxOutputTokens) : body.maxOutputTokens;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      errors.push({ field: "maxOutputTokens", message: "must be a positive integer" });
    } else {
      maxOutputTokens = n;
    }
  }

  let contextWindow = existing?.contextWindow;
  if (body.contextWindow === null || body.contextWindow === "") {
    contextWindow = undefined; // explicit clear
  } else if (body.contextWindow !== undefined) {
    const n = typeof body.contextWindow === "string" ? Number(body.contextWindow) : body.contextWindow;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 4096 || n > 10_000_000) {
      errors.push({ field: "contextWindow", message: "must be a whole number from 4096 to 10000000 (leave empty if unknown)" });
    } else {
      contextWindow = n;
    }
  }

  let key = existing?.key;
  if (body.key !== undefined) {
    const k = body.key === null ? "" : (body.key as unknown as string);
    if (!k) {
      key = undefined; // pool
    } else if (typeof k !== "string" || !c.providers[provider as string]?.keys.includes(k)) {
      errors.push({
        field: "key",
        message: "must be one of the pinned provider's keys (or empty for the pool)",
      });
    } else {
      key = k;
    }
  }

  let price = existing?.price;
  try {
    if (body.price === null) {
      price = undefined; // explicit clear
    } else {
      const p = validatePrice(body.price);
      if (p !== undefined) price = p;
    }
  } catch (e) {
    errors.push(...(e as ValidationError).errors);
  }

  let fallback = existing?.fallback;
  if (body.fallback !== undefined) {
    if (!Array.isArray(body.fallback)) {
      errors.push({ field: "fallback", message: "must be a list of model aliases" });
    } else {
      const list = body.fallback.map(String).filter(Boolean);
      for (const f of list) {
        if (!c.models[f]) {
          errors.push({ field: "fallback", message: `"${f}" is not a known model` });
        }
      }
      fallback = list.length ? list : undefined;
    }
  }

  if (errors.length) throw new ValidationError(errors);

  const out: ModelCfg = { provider: provider as string, model: (model as string).trim() };
  if (key) out.key = key;
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  if (fallback?.length) out.fallback = fallback;
  if (price) out.price = price;
  return out;
}

// A fallback chain must be acyclic, otherwise the proxy could loop forever.
export function validateNoCycle(models: Record<string, ModelCfg>, changed: string): void {
  const state = new Map<string, 0 | 1 | 2>();
  const walk = (name: string, trail: string[]): void => {
    const s = state.get(name) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      throw new ValidationError([
        {
          field: "fallback",
          message: `cycle detected: ${[...trail, name].join(" -> ")}`,
        },
      ]);
    }
    state.set(name, 1);
    for (const next of models[name]?.fallback ?? []) walk(next, [...trail, name]);
    state.set(name, 2);
  };
  walk(changed, []);
}
