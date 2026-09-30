import { db, getSetting } from "./db";

/**
 * Context guard = "observation masking" for coding agents.
 *
 * Claude Code re-sends the whole transcript on every request, and most of it is old tool output
 * (file reads, grep results, command logs). The model does not need those old outputs in full.
 * The guard replaces the OLD ones with a one-line stub before the request goes upstream and keeps the
 * newest few intact. The router REMEMBERS which tool results it already cleared in this session (SQLite),
 * so every later request gets exactly the same stubs. That keeps the start of the prompt byte-identical,
 * which is what lets the provider's prompt cache keep hitting (a moving window would break the cache
 * on every request). Clearing happens in rare batches: when the prompt passes `highTokens` it is cleared
 * down to `lowTokens` in one go.
 *
 * Modes: off | shadow (measure only, never changes a request) | on.
 */
export type GuardMode = "off" | "shadow" | "on";

export interface GuardConfig {
  mode: GuardMode;
  highTokens: number;
  lowTokens: number;
  keepRecent: number;
  minChars: number;
}

export interface GuardResult {
  mode: GuardMode;
  beforeTokens: number;
  afterTokens: number;
  /** Tokens actually removed from this request (mode "on"). */
  saved: number;
  /** Tokens the guard would remove (mode "shadow"). */
  would: number;
  clearedNow: number;
  clearedTotal: number;
}

export function readConfig(): GuardConfig {
  return {
    mode: getSetting("guard.mode") as GuardMode,
    highTokens: Number(getSetting("guard.highTokens")),
    lowTokens: Number(getSetting("guard.lowTokens")),
    keepRecent: Number(getSetting("guard.keepRecent")),
    minChars: Number(getSetting("guard.minChars")),
  };
}

const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1700;

interface Slot {
  mi: number;
  bi: number;
  id: string;
  chars: number;
  hasImage: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const stubFor = (chars: number): string =>
  `[router: output of this tool call was cleared to save tokens (${chars} characters). Run the tool again if you still need it.]`;

/** Rough size of the whole prompt. Images are counted as a fixed cost instead of their base64 length. */
export function estimateTokens(body: Json): number {
  let images = 0;
  const text = JSON.stringify(body, (k, v) => {
    if (k === "data" && typeof v === "string" && v.length > 2000) {
      images++;
      return "";
    }
    return v;
  });
  return Math.ceil(text.length / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

function collect(messages: Json[]): Slot[] {
  const slots: Slot[] = [];
  messages.forEach((msg, mi) => {
    if (msg?.role !== "user" || !Array.isArray(msg.content)) return;
    msg.content.forEach((blk: Json, bi: number) => {
      if (blk?.type !== "tool_result" || typeof blk.tool_use_id !== "string") return;
      let chars = 0;
      let hasImage = false;
      const c = blk.content;
      if (typeof c === "string") chars = c.length;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (part?.type === "text") chars += String(part.text ?? "").length;
          else if (part?.type === "image") hasImage = true;
          else chars += JSON.stringify(part ?? "").length;
        }
      }
      slots.push({ mi, bi, id: blk.tool_use_id, chars, hasImage });
    });
  });
  return slots;
}

// ---------- per-session memory ----------
const selectIds = db.prepare("SELECT tool_use_id FROM guard_cleared WHERE session_id = ?");
const insertId = db.prepare("INSERT OR IGNORE INTO guard_cleared(session_id, tool_use_id, chars, created_at) VALUES (?,?,?,?)");
const shadowMemory = new Map<string, Set<string>>();

function loadCleared(sessionId: string, mode: GuardMode): Set<string> {
  if (mode === "shadow") {
    let s = shadowMemory.get(sessionId);
    if (!s) shadowMemory.set(sessionId, (s = new Set()));
    if (shadowMemory.size > 500) shadowMemory.delete(shadowMemory.keys().next().value as string);
    return s;
  }
  return new Set((selectIds.all(sessionId) as { tool_use_id: string }[]).map((r) => r.tool_use_id));
}

export function pruneGuardMemory(days = 7): void {
  db.prepare("DELETE FROM guard_cleared WHERE created_at < ?").run(Date.now() - days * 86400_000);
}

/** Returns the body to send upstream (a new object when changed) plus what happened. Never throws. */
export function applyGuard(body: Json, sessionId: string, cfg: GuardConfig = readConfig()): { body: Json; result: GuardResult } {
  const none = (before: number): { body: Json; result: GuardResult } => ({
    body,
    result: { mode: cfg.mode, beforeTokens: before, afterTokens: before, saved: 0, would: 0, clearedNow: 0, clearedTotal: 0 },
  });
  try {
    if (cfg.mode === "off" || !Array.isArray(body?.messages)) return none(0);
    const messages: Json[] = body.messages;
    const before = estimateTokens(body);
    const slots = collect(messages);
    if (!slots.length) return none(before);

    const protectedFrom = Math.max(0, slots.length - cfg.keepRecent);
    const isProtected = (i: number) => i >= protectedFrom;
    const cleared = loadCleared(sessionId, cfg.mode);
    const stubTokens = (chars: number) => Math.ceil(stubFor(chars).length / CHARS_PER_TOKEN);
    const gain = (s: Slot) => Math.max(0, Math.ceil(s.chars / CHARS_PER_TOKEN) - stubTokens(s.chars));

    // 1) everything remembered from earlier requests is applied again, unchanged.
    const apply = new Set<number>();
    let est = before;
    slots.forEach((s, i) => {
      if (cleared.has(s.id) && !isProtected(i) && !s.hasImage) {
        apply.add(i);
        est -= gain(s);
      }
    });

    // 2) only when the prompt is over the high-water mark, clear MORE (oldest first) down to the low-water mark.
    let clearedNow = 0;
    if (est > cfg.highTokens) {
      for (let i = 0; i < protectedFrom && est > cfg.lowTokens; i++) {
        const s = slots[i];
        if (apply.has(i) || s.hasImage || s.chars < cfg.minChars) continue;
        apply.add(i);
        est -= gain(s);
        clearedNow++;
        if (cfg.mode === "on") insertId.run(sessionId, s.id, s.chars, Date.now());
        else cleared.add(s.id);
      }
    }
    if (!apply.size) return { body, result: { ...none(before).result, clearedTotal: cleared.size } };

    const saved = Math.max(0, before - est);
    const result: GuardResult = {
      mode: cfg.mode,
      beforeTokens: before,
      afterTokens: est,
      saved: cfg.mode === "on" ? saved : 0,
      would: cfg.mode === "shadow" ? saved : 0,
      clearedNow,
      clearedTotal: apply.size,
    };
    if (cfg.mode !== "on") return { body, result: { ...result, afterTokens: before } };

    const nextMessages = messages.slice();
    const touched = new Map<number, Json>();
    for (const i of apply) {
      const s = slots[i];
      const msg = touched.get(s.mi) ?? { ...messages[s.mi], content: messages[s.mi].content.slice() };
      msg.content[s.bi] = { ...msg.content[s.bi], content: stubFor(s.chars) };
      touched.set(s.mi, msg);
    }
    for (const [mi, msg] of touched) nextMessages[mi] = msg;
    return { body: { ...body, messages: nextMessages }, result };
  } catch (e) {
    console.warn("[GUARD] skipped:", (e as Error).message);
    return none(0);
  }
}

export function guardStats(sinceMs: number): { requests: number; saved: number; would: number; input: number } {
  const r = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(guard_saved),0) AS s, COALESCE(SUM(guard_would),0) AS w, COALESCE(SUM(ctx_tokens),0) AS c FROM requests WHERE ended_at >= ? AND (guard_saved > 0 OR guard_would > 0)",
  ).get(Date.now() - sinceMs) as { n: number; s: number; w: number; c: number };
  return { requests: r.n, saved: r.s, would: r.w, input: r.c };
}
