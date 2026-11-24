import type { ModelCfg, ProviderCfg } from "./config";
import { solvePoW } from "./dsw-pow";

/**
 * Native "DeepSeek web -> API" protocol adapter for chat.deepseek.com, reverse-engineered from the
 * web app's own traffic (same flow as the DeepSeek-Free-API projects, but built into the router with
 * no third-party service in between and zero npm dependencies).
 *
 * Flow per request: exchange the browser userToken (the `userToken` value in chat.deepseek.com's
 * localStorage, stored in .env under the provider's key name) for a 1-hour-cached access token, solve
 * a proof-of-work challenge with DeepSeek's own wasm (src/dsw-pow.ts), create a chat session, POST the
 * merged conversation as one prompt and read the patch-style SSE answer.
 *
 * The wrapper returns plain Response objects, so the router's existing status-based failure handling
 * (cooldown, failover, retry) works unchanged: auth problems come back as 401, rate limits as 429,
 * anything else as 502.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// Test seam: point the adapter at a mock server (DS_WEB_BASE) without touching the strict
// baseURL validation, which keeps https://chat.deepseek.com as the only user-facing address.
const DS_BASE = (process.env.DS_WEB_BASE ?? "").trim() || "https://chat.deepseek.com";
const COMPLETION_PATH = "/api/v0/chat/completion";
const TOKEN_TTL_MS = 3600_000;

// Browser-identical headers; DeepSeek rejects requests that do not look like their own web app.
const FAKE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: DS_BASE,
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: `${DS_BASE}/`,
  "Sec-Ch-Ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "X-App-Version": "20241129.1",
  "X-Client-Locale": "en-US",
  "X-Client-Platform": "web",
  "X-Client-Version": "1.6.1",
};

// Model ids understood by the DeepSeek web endpoint; -think/-r1/-silent/-fold enable thinking,
// -search enables web search (same flag-in-name convention as the web app).
export const DS_MODELS = [
  "deepseek-chat", "deepseek-coder", "deepseek-think", "deepseek-r1",
  "deepseek-v4-flash", "deepseek-v4-pro",
  "deepseek-v4-flash-think", "deepseek-v4-pro-think",
  "deepseek-search", "deepseek-v4-flash-search", "deepseek-v4-pro-search",
  "deepseek-v4-flash-think-search", "deepseek-v4-pro-think-search",
];

const errRes = (status: number, message: string): Response =>
  new Response(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }), { status, headers: { "content-type": "application/json" } });

/** Upstream answered with HTTP ok but a non-zero business code; map it onto a real HTTP status. */
class DsBizError extends Error {
  constructor(readonly status: number, msg: string) { super(msg); }
}

// ---------- access token (browser userToken -> API access token, cached 1h per key) ----------

const tokenCache = new Map<string, { token: string; exp: number }>();

function invalidateToken(keyName: string): void {
  tokenCache.delete(keyName);
}

async function dsJson(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return fetch(`${DS_BASE}${path}`, {
    ...init,
    headers: { ...FAKE_HEADERS, ...(init.headers as Record<string, string>) },
    signal,
  });
}

/** Check the {code, data, msg} envelope every chat.deepseek.com endpoint returns. */
/** Optional `shape` collects key NAMES and types only — never values — for error diagnostics. */
async function checkDs(res: Response, keyName: string, shape?: { status: number; envelope: string; envelopeKeys: string[]; dataKeys: string[] }): Promise<Json> {
  let j: Json = null;
  try { j = JSON.parse(await res.text()); } catch { /* non-JSON body */ }
  if (shape) {
    shape.status = res.status;
    shape.envelope = j === null ? "non-JSON body" : Array.isArray(j) ? "array" : typeof j;
    shape.envelopeKeys = j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j).slice(0, 12) : [];
    const d = shape.envelopeKeys.includes("data") ? j.data : undefined;
    shape.dataKeys = d === undefined || d === null ? [] : Array.isArray(d) ? ["array"] : typeof d === "object" ? Object.keys(d).slice(0, 12) : [typeof d];
  }
  if (res.status >= 400) throw new DsBizError(res.status === 401 || res.status === 403 ? 401 : res.status, `DeepSeek web HTTP ${res.status}: ${typeof j?.msg === "string" ? j.msg : res.statusText}`);
  if (j && Number.isFinite(j.code)) {
    if (j.code === 0) return j.data;
    if (j.code === 40003) invalidateToken(keyName); // access token expired mid-flight
    throw new DsBizError(j.code === 40003 ? 401 : j.code === 429 ? 429 : 502, `DeepSeek web error ${j.code}: ${j.msg ?? "unknown"}`);
  }
  return j;
}

async function acquireToken(keyName: string, signal: AbortSignal): Promise<string> {
  const cached = tokenCache.get(keyName);
  if (cached && Date.now() < cached.exp) return cached.token;
  const userToken = (process.env[keyName] ?? "").trim();
  if (!userToken) throw new DsBizError(401, `${keyName} is empty or missing in .env (paste the userToken value from chat.deepseek.com's browser localStorage)`);
  const res = await dsJson("/api/v0/users/current", { method: "GET", headers: { Authorization: `Bearer ${userToken}` } }, signal);
  const data = await checkDs(res, keyName);
  const token = data?.biz_data?.token;
  if (typeof token !== "string" || !token) throw new DsBizError(502, "DeepSeek web did not return an access token");
  tokenCache.set(keyName, { token, exp: Date.now() + TOKEN_TTL_MS });
  return token;
}

// ---------- proof of work + session ----------

/** Build the X-Ds-Pow-Response header value: fetch a challenge, solve it locally, base64 the answer. */
async function powHeader(token: string, signal: AbortSignal): Promise<string> {
  const res = await dsJson("/api/v0/chat/create_pow_challenge", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ target_path: COMPLETION_PATH }),
  }, signal);
  const c = (await checkDs(res, ""))?.biz_data?.challenge;
  if (!c || c.algorithm !== "DeepSeekHashV1") throw new DsBizError(502, "DeepSeek web sent an unsupported PoW challenge");
  const answer = await solvePoW(String(c.challenge), `${c.salt}_${c.expire_at}_`, Number(c.difficulty) || 200000);
  if (answer === undefined) throw new DsBizError(502, "PoW challenge could not be solved within its difficulty bound");
  return Buffer.from(JSON.stringify({
    algorithm: c.algorithm, challenge: c.challenge, salt: c.salt, answer, signature: c.signature, target_path: COMPLETION_PATH,
  })).toString("base64");
}

async function createSession(token: string, signal: AbortSignal): Promise<string> {
  const res = await dsJson("/api/v0/chat_session/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ character_id: null }),
  }, signal);
  const shape = { status: 0, envelope: "", envelopeKeys: [] as string[], dataKeys: [] as string[] };
  const data = await checkDs(res, "", shape);
  const id = data?.biz_data?.id ?? data?.id ?? (typeof data === "string" ? data : undefined);
  if (!id) {
    const shapeTxt = `HTTP ${shape.status}, envelope ${shape.envelope}${shape.envelopeKeys.length ? ` {${shape.envelopeKeys.join(", ")}}` : ""}${shape.dataKeys.length ? `, data {${shape.dataKeys.join(", ")}}` : ""}`;
    throw new DsBizError(502, `DeepSeek web refused to create a chat session (${shapeTxt})`);
  }
  return String(id);
}

// ---------- Anthropic messages -> one DeepSeek prompt ----------

const blocksOf = (m: Json): Json[] =>
  typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];

const blockText = (b: Json): string => {
  if (!b || typeof b === "string") return String(b ?? "");
  if (b.type === "text") return String(b.text ?? "");
  if (b.type === "thinking") return ""; // internal reasoning is not replayed to the model
  if (b.type === "tool_use") return `[Tool call ${b.name} with ${JSON.stringify(b.input ?? {})}]`;
  if (b.type === "tool_result") return `[Tool result]: ${typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x: Json) => String(x?.text ?? "")).join("\n") : ""}`;
  return "[image omitted]";
};

/**
 * Merge the Anthropic conversation into the single prompt string the web endpoint expects:
 * consecutive same-role turns join, the first block stays bare, later user/system blocks get a
 * <｜User｜> marker and assistant blocks get <｜Assistant｜> ... <｜end of sentence｜>.
 */
export function messagesToPrompt(body: Json): string {
  const msgs: { role: string; text: string }[] = [];
  const sys = body?.system;
  const sysText = typeof sys === "string" ? sys : Array.isArray(sys) ? sys.map(blockText).join("\n\n") : "";
  if (sysText.trim()) msgs.push({ role: "system", text: sysText });
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    msgs.push({ role: m.role, text: blocksOf(m).map(blockText).filter((t) => t.length > 0).join("\n") });
  }
  if (!msgs.length) return "";
  const merged: { role: string; text: string }[] = [];
  for (const msg of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) last.text += `\n\n${msg.text}`;
    else merged.push({ ...msg });
  }
  return merged
    .map((b, i) => {
      if (b.role === "assistant") return `<｜Assistant｜>${b.text}<｜end of sentence｜>`;
      if (b.role === "user" || b.role === "system") return i > 0 ? `<｜User｜>${b.text}` : b.text;
      return b.text;
    })
    .join("")
    .replace(/!\[.+\]\(.+\)/g, "");
}

// ---------- the upstream wrapper the route loop calls ----------

/** Run the whole DeepSeek web flow; returns the raw SSE Response on success, or an error Response whose status feeds the router's failover logic. */
export async function dsWebUpstream(m: ModelCfg, p: ProviderCfg, keyName: string, body: Json, signal: AbortSignal): Promise<Response> {
  try {
    const token = await acquireToken(keyName, signal);
    const prompt = messagesToPrompt(body);
    if (!prompt) return errRes(400, "nothing to send: the request has no text messages");
    const thinking = /think|r1|silent|fold/.test(m.model);
    const search = /search/.test(m.model);
    const pow = await powHeader(token, signal);
    const sessionId = await createSession(token, signal);
    const res = await dsJson(COMPLETION_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "X-Ds-Pow-Response": pow },
      body: JSON.stringify({ chat_session_id: sessionId, parent_message_id: null, prompt, ref_file_ids: [], search_enabled: search, thinking_enabled: thinking }),
    }, signal);
    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      throw new DsBizError(res.status === 401 || res.status === 403 ? 401 : res.status, `DeepSeek web completion HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/event-stream")) {
      const text = await res.text().catch(() => "");
      throw new DsBizError(502, `DeepSeek web sent ${ct || "no content-type"} instead of an event stream: ${text.slice(0, 200)}`);
    }
    return res;
  } catch (e) {
    if (signal.aborted) throw e; // client hung up: let the route loop handle it like any other abort
    if (e instanceof DsBizError) return errRes(e.status, e.message);
    const msg = (e as Error).message ?? "unknown error";
    return errRes(502, `DeepSeek web request failed: ${msg}`);
  }
}

// ---------- DS patch-SSE -> Anthropic ----------

const rid = (): string => `msg_${Math.random().toString(36).slice(2, 12)}`;

const usageOf = (completionTokens: number, estIn: number, chars: number) => ({
  input_tokens: estIn,
  output_tokens: completionTokens > 0 ? completionTokens : Math.ceil(chars / 3.5),
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/** Anthropic SSE stream (message_start / content_block_* / message_delta / message_stop). */
export function dsWebToAnthropic(up: Response, model: string, estIn = 0): Response {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const emit = (event: string, data: Json) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      let started = false, idx = -1, openKind: "" | "thinking" | "text" = "", usage = 0, chars = 0, buf = "";
      let path: "thinking" | "content" = "content";
      const searchResults: Json[] = [];
      const begin = () => {
        if (started) return;
        started = true;
        emit("message_start", { type: "message_start", message: { id: rid(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estIn, output_tokens: 0 } } });
      };
      const close = () => {
        if (openKind) { emit("content_block_stop", { type: "content_block_stop", index: idx }); openKind = ""; }
      };
      const open = (kind: "thinking" | "text") => {
        if (openKind === kind) return;
        close();
        idx++; openKind = kind;
        emit("content_block_start", { type: "content_block_start", index: idx, content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" } });
      };
      const push = (kind: "thinking" | "text", text: string) => {
        if (!text) return;
        open(kind);
        chars += text.length;
        emit("content_block_delta", { type: "content_block_delta", index: idx, delta: kind === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text } });
      };
      const handle = (chunk: Json) => {
        if (chunk?.v?.response) path = chunk.v.response.thinking_enabled ? "thinking" : "content";
        else if (chunk?.p === "response/fragments") path = "content";
        else if (chunk?.p === "response/search_status") return;
        if (chunk?.p === "response" && Array.isArray(chunk.v)) {
          for (const e of chunk.v) if (e?.p === "accumulated_token_usage" && typeof e.v === "number") usage = e.v;
          return;
        }
        if (chunk?.p === "response/search_results" && Array.isArray(chunk.v)) {
          if (chunk.o !== "BATCH") searchResults.push(...chunk.v);
          else for (const op of chunk.v) {
            const match = typeof op?.p === "string" ? op.p.match(/^(\d+)\/cite_index$/) : null;
            if (match) searchResults[Number(match[1])] = { ...searchResults[Number(match[1])], cite_index: op.v };
          }
          return;
        }
        if (typeof chunk?.v === "string" || Array.isArray(chunk?.v)) {
          let c = "";
          if (Array.isArray(chunk.v)) {
            for (const e of chunk.v) if (Array.isArray(e?.v)) c += e.v.map((v: Json) => String(v?.content ?? "")).join("");
          } else {
            c = chunk.v;
          }
          const cleaned = c.replace(/FINISHED/g, "").replace(/\[citation:(\d+)\]/g, "[$1]");
          push(path === "thinking" ? "thinking" : "text", cleaned);
        }
      };
      begin(); // message_start must precede any content_block_* events
      try {
        const reader = (up.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try { handle(JSON.parse(payload)); } catch { /* keep-alive or partial line */ }
          }
        }
      } catch (e) {
        begin(); close();
        emit("error", { type: "error", error: { type: "api_error", message: `deepseek web stream failed: ${(e as Error).message}` } });
        ctrl.close();
        return;
      }
      begin();
      close();
      if (searchResults.some((r) => r?.cite_index)) {
        const citations = searchResults
          .filter((r) => r.cite_index)
          .sort((a, b) => a.cite_index - b.cite_index)
          .map((r) => `[${r.cite_index}]: [${r.title}](${r.url})`)
          .join("\n");
        if (citations) push("text", `\n\n${citations}`);
      }
      close();
      emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: usageOf(usage, estIn, chars) });
      emit("message_stop", { type: "message_stop" });
      ctrl.close();
    },
    cancel() { up.body?.cancel().catch(() => undefined); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Collect a non-streaming DeepSeek web answer into an Anthropic message JSON. */
export async function dsWebToJson(up: Response, model: string, estIn = 0): Promise<Json> {
  // Reuse the streaming path with an accumulator instead of duplicating the patch parser.
  const sse = dsWebToAnthropic(up, model, estIn);
  const text = await sse.text();
  let content: Json[] = [];
  let usage: Json = null;
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    try {
      const j = JSON.parse(dataLine.slice(6));
      if (j.type === "content_block_start") content[j.index] = j.content_block;
      else if (j.type === "content_block_delta") {
        const b = content[j.index] ?? {};
        if (j.delta?.type === "thinking_delta") b.thinking = (b.thinking ?? "") + j.delta.thinking;
        else if (j.delta?.type === "text_delta") b.text = (b.text ?? "") + j.delta.text;
      } else if (j.type === "message_delta") usage = j.usage;
    } catch { /* skip malformed frame */ }
  }
  content = content.filter((b) => b && (b.type !== "text" || (b.text ?? "").length > 0));
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: rid(), type: "message", role: "assistant", model, content,
    stop_reason: "end_turn", stop_sequence: null,
    usage: usage ?? usageOf(0, estIn, 0),
  };
}

/** Turn a successful DeepSeek web response into the Anthropic-style one the rest of the router expects. */
export async function adaptDeepSeekWeb(up: Response, stream: boolean, model: string, estIn: number): Promise<Response> {
  if (stream && up.body) return dsWebToAnthropic(up, model, estIn);
  const j = await dsWebToJson(up, model, estIn);
  return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
}

/** One-shot, non-streaming call used by memory summaries and connection tests. */
export async function dsWebCallOnce(m: ModelCfg, p: ProviderCfg, keyName: string, body: Json, signal: AbortSignal): Promise<{ status: number; raw: string; json: Json | null }> {
  const up = await dsWebUpstream(m, p, keyName, { ...body, stream: false }, signal);
  if (up.status >= 400) return { status: up.status, raw: await up.text().catch(() => ""), json: null };
  try {
    const j = await dsWebToJson(up, m.model);
    return { status: 200, raw: JSON.stringify(j), json: j };
  } catch (e) {
    return { status: 502, raw: (e as Error).message, json: null };
  }
}
