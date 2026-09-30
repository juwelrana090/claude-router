# 13 — Backend: fix Ollama, OpenAI-style providers (Groq, Gemini, Cerebras...), provider catalog, address checks

**Run after 09–12.** Node server only, plus one line in `routes.json`. Then run `14-web-catalog-instructions.md`.

## Why Ollama fails, and what else this adds

**Your Ollama error.** The screenshot says `path "/api/v1/messages" not found`. Your `routes.json` has the Ollama provider at `https://ollama.com/api`. The router always adds `/v1/messages` for Claude-format providers, so it called `https://ollama.com/api/v1/messages`, which does not exist. Ollama's docs give the Claude-format cloud address as `https://ollama.com/v1/messages` and say it needs `Authorization: Bearer <key>` (your Auth mode `both` already sends that). The model id is fine: `deepseek-v4.1-flash` is in Ollama's own cloud list. Step 3 below fixes the one line. One more thing you cannot fix in code: a **free** Ollama account only has starter credits for a smaller set of starter models and one request at a time, so if that model then answers with a plan or credit error, pick another model or add credits.

What this step adds:
1. **Address checks** (`baseURLProblem` in `src/config.ts`), run whenever a provider is created or edited: an address ending in `/v1/messages` or `/chat/completions`, a Claude-format address ending in `/v1`, and `https://ollama.com/api` are refused with the reason and the right address. Before, these only showed up later as a 404.
2. **Plain-language hints** on failed connection tests (`POST /admin/models/:alias/test` returns `hint`): wrong address (404), key refused (401/403), no balance or credits or too many requests (402/429), unknown model (400).
3. **OpenAI-style providers** (`src/openai.ts`, provider field `protocol: "openai"`). Many free tiers (Groq, Google Gemini, Cerebras, NVIDIA NIM, Mistral) only speak the OpenAI chat format. For such a provider the router converts the request (system prompt, text, images, tools, tool calls, tool results, tool_choice, max_tokens, temperature, stop) and converts the answer back, both plain and streamed (same event order as Claude's API, tool arguments as `input_json_delta`, cached tokens split out of the usage). Claude-only fields (`thinking`, `metadata`, cache markers) are not sent. Failover, history, daily limits, context window, the guard and router memory work on these providers unchanged; a free OpenAI-style model can even be the one that writes the memory summaries. Auth is `Authorization: Bearer`.
4. **Provider catalog** (`src/catalog.ts`, `GET /admin/catalog`, `POST /admin/catalog/add`): 14 providers (Ollama local and cloud, OpenRouter free, OpenCode Zen, Z.ai, DeepSeek, Moonshot/Kimi, MiniMax, Qwen, Groq, Cerebras, Gemini, NVIDIA NIM, Mistral) with the exact address, login style, format, where to get a key, free limits, privacy notes, model ids and prices, and the date and source they were checked against. One call creates the provider, stores the key in `.env`, and creates the chosen models (alias auto-generated and made unique; catalog prices applied); a failed call creates nothing. Free tiers get a sensible daily limit (OpenRouter 50 requests, Groq 1,000 requests, Cerebras 1,000,000 tokens) so the router switches away before the quota is gone.

What I verified and what I did not: the Ollama address and Bearer rule, the model ids and the prices come from Ollama's own docs and pricing page fetched today; the Gemini address from Google's docs. Endpoints for DeepSeek, Z.ai, Moonshot, MiniMax, Qwen, Groq, Cerebras, NVIDIA and Mistral, and all free-tier limits, come from provider docs as quoted by community lists and comparison articles from May-August 2026; the catalog says so on each card. Free tiers change without notice. Not verified: how each real provider handles every Claude Code feature (tool use and streaming are tested against a mock; models differ in how well they call tools).

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create these new files

### `src/openai.ts` — NEW file

````ts
import type { ModelCfg, ProviderCfg } from "./config";

/**
 * Protocol adapter for providers that only speak the OpenAI "chat completions" format (Groq, Cerebras,
 * Google Gemini, NVIDIA NIM, Mistral ...). Claude Code speaks Anthropic's Messages format, so for a provider
 * with `protocol: "openai"` the router converts the request, and converts the answer (plain or streamed) back,
 * so the rest of the router (failover, history, memory, guard) does not know the difference.
 * Thinking blocks and cache markers are dropped; images, tools, tool calls and tool results are kept.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const openaiHeaders = (p: ProviderCfg, keyName: string): Record<string, string> => ({
  "content-type": "application/json",
  ...(p.auth === "none" ? {} : { authorization: `Bearer ${process.env[keyName] ?? ""}` }),
});

const blocksOf = (m: Json): Json[] =>
  typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];

const plain = (c: Json): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x: Json) => (x?.type === "text" ? String(x.text ?? "") : "[image omitted]")).join("\n") : "";

function convertMessages(body: Json): Json[] {
  const out: Json[] = [];
  const sys = body.system;
  const sysText = typeof sys === "string" ? sys : Array.isArray(sys) ? sys.map((b: Json) => String(b?.text ?? "")).join("\n\n") : "";
  if (sysText) out.push({ role: "system", content: sysText });
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const blocks = blocksOf(m);
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("");
      const calls = blocks.filter((b) => b?.type === "tool_use").map((b) => ({
        id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg: Json = { role: "assistant", content: text || (calls.length ? null : "") };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    // user turn: tool results must directly follow the assistant tool_calls, so they go first
    const parts: Json[] = [];
    for (const b of blocks) {
      if (b?.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: `${b.is_error ? "ERROR: " : ""}${plain(b.content)}` });
      } else if (b?.type === "text") parts.push({ type: "text", text: String(b.text ?? "") });
      else if (b?.type === "image" && b.source?.type === "base64") {
        parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
    }
    if (parts.length) out.push({ role: "user", content: parts.every((x) => x.type === "text") ? parts.map((x) => x.text).join("\n") : parts });
  }
  return out;
}

export function toOpenAIRequest(body: Json, m: ModelCfg, p: ProviderCfg): string {
  const out: Json = { model: m.model, messages: convertMessages(body) };
  let max = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
  if (max !== undefined && m.maxOutputTokens && max > m.maxOutputTokens) max = m.maxOutputTokens;
  if (max !== undefined) out.max_tokens = max;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t: Json) => t?.name && t?.input_schema);
  if (tools.length) {
    out.tools = tools.map((t: Json) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
    const tc = body.tool_choice;
    if (tc?.type === "auto") out.tool_choice = "auto";
    else if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "none") out.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  for (const f of p.dropBodyFields ?? []) delete out[f];
  return JSON.stringify(out);
}

const STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "end_turn" };
const stopOf = (r: unknown): string => STOP[String(r)] ?? "end_turn";
const rid = (): string => `msg_${Math.random().toString(36).slice(2, 12)}`;
const tid = (): string => `toolu_${Math.random().toString(36).slice(2, 12)}`;

function usageOf(u: Json, estIn: number, estOutChars: number): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  const prompt = Number(u?.prompt_tokens);
  const cached = Number(u?.prompt_tokens_details?.cached_tokens) || 0;
  const out = Number(u?.completion_tokens);
  return {
    input_tokens: Number.isFinite(prompt) ? Math.max(0, prompt - cached) : estIn,
    output_tokens: Number.isFinite(out) ? out : Math.ceil(estOutChars / 3.5),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** OpenAI chat completion JSON -> Anthropic message JSON. */
export function fromOpenAIResponse(j: Json, model: string, estIn = 0): Json {
  const ch = j?.choices?.[0];
  const msg = ch?.message ?? {};
  const content: Json[] = [];
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((x: Json) => String(x?.text ?? "")).join("") : "";
  if (text) content.push({ type: "text", text });
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    let input: Json = {};
    try { input = JSON.parse(tc?.function?.arguments || "{}"); } catch { /* keep {} */ }
    content.push({ type: "tool_use", id: tc?.id || tid(), name: String(tc?.function?.name ?? ""), input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const hasTool = content.some((b) => b.type === "tool_use");
  return {
    id: j?.id ? String(j.id) : rid(), type: "message", role: "assistant", model, content,
    stop_reason: hasTool ? "tool_use" : stopOf(ch?.finish_reason), stop_sequence: null, usage: usageOf(j?.usage, estIn, text.length),
  };
}

/** OpenAI SSE stream -> Anthropic SSE stream. */
export function streamToAnthropic(up: Response, model: string, estIn = 0): Response {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const emit = (event: string, data: Json) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      let started = false, idx = -1, open = false, stop = "end_turn", sawTool = false, usage: Json = null, chars = 0, buf = "";
      const tools = new Map<number, number>();
      const begin = () => {
        if (started) return;
        started = true;
        emit("message_start", { type: "message_start", message: { id: rid(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      };
      const close = () => { if (open) { emit("content_block_stop", { type: "content_block_stop", index: idx }); open = false; } };
      let textOpen = false;
      const handle = (j: Json) => {
        begin();
        if (j?.usage) usage = j.usage;
        const ch = j?.choices?.[0];
        if (!ch) return;
        const d = ch.delta ?? {};
        if (typeof d.content === "string" && d.content.length) {
          if (!textOpen) { close(); idx++; open = true; textOpen = true; emit("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }); }
          chars += d.content.length;
          emit("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: d.content } });
        }
        for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
          const ti = Number.isInteger(tc?.index) ? tc.index : 0;
          let block = tools.get(ti);
          if (block === undefined) {
            close(); textOpen = false; idx++; open = true; block = idx; tools.set(ti, block); sawTool = true;
            emit("content_block_start", { type: "content_block_start", index: block, content_block: { type: "tool_use", id: tc?.id || tid(), name: String(tc?.function?.name ?? ""), input: {} } });
          }
          const args = tc?.function?.arguments;
          if (typeof args === "string" && args.length) { chars += args.length; emit("content_block_delta", { type: "content_block_delta", index: block, delta: { type: "input_json_delta", partial_json: args } }); }
        }
        if (ch.finish_reason) stop = stopOf(ch.finish_reason);
      };
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
        emit("error", { type: "error", error: { type: "api_error", message: `upstream stream failed: ${(e as Error).message}` } });
        ctrl.close();
        return;
      }
      begin(); close();
      const u = usageOf(usage, estIn, chars);
      emit("message_delta", { type: "message_delta", delta: { stop_reason: sawTool ? "tool_use" : stop, stop_sequence: null }, usage: u });
      emit("message_stop", { type: "message_stop" });
      ctrl.close();
    },
    cancel() { up.body?.cancel().catch(() => undefined); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Turn a successful OpenAI-style upstream response into the Anthropic-style one the rest of the router expects. */
export async function adaptOpenAI(up: Response, stream: boolean, model: string, estIn: number): Promise<Response> {
  if (stream && up.body) return streamToAnthropic(up, model, estIn);
  const raw = await up.text();
  let j: Json = {};
  try { j = JSON.parse(raw); } catch {
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `provider sent something that is not JSON: ${raw.slice(0, 120)}` } }), { status: 502, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify(fromOpenAIResponse(j, model, estIn)), { status: 200, headers: { "content-type": "application/json" } });
}

/** One-shot, non-streaming call used by memory summaries and connection tests. Returns the Anthropic-shaped JSON. */
export async function callOnce(m: ModelCfg, p: ProviderCfg, keyName: string, body: Json, signal: AbortSignal): Promise<{ status: number; raw: string; json: Json | null }> {
  const url = `${p.baseURL}/chat/completions`;
  const res = await fetch(url, { method: "POST", headers: openaiHeaders(p, keyName), body: toOpenAIRequest({ ...body, stream: false }, m, p), signal });
  const raw = await res.text();
  if (!res.ok) return { status: res.status, raw, json: null };
  try { return { status: res.status, raw, json: fromOpenAIResponse(JSON.parse(raw), m.model) }; } catch { return { status: 502, raw, json: null }; }
}
````

### `src/catalog.ts` — NEW file

````ts
import type { Protocol } from "./config";

/**
 * Providers worth adding for coding, with the exact address the router needs.
 * Facts were checked against the providers' own pages or docs on the date in `verified`.
 * Free tiers change without notice: every entry links to where the current numbers live.
 */
export interface CatalogModel {
  id: string; // the provider's own model id
  label: string;
  coding?: boolean;
  free?: boolean;
  price?: { in: number; out: number; cacheRead?: number; peak?: boolean }; // USD per 1M tokens
  note?: string;
}

export interface CatalogEntry {
  id: string; // also the default provider name in the router
  name: string;
  tier: "local" | "free" | "freemium" | "cheap";
  protocol: Protocol;
  baseURL: string;
  auth: "bearer" | "x-api-key" | "both" | "none";
  keyUrl?: string;
  pricingUrl?: string;
  summary: string;
  limits?: string;
  privacy?: string;
  steps: string[];
  models: CatalogModel[];
  /** Shown when the provider's model list changes too often to hard-code. */
  customModelHint?: string;
  /** Applied when the provider is created, so the router switches away before the free quota runs out. */
  suggestedLimits?: { dailyRequests?: number; dailyTokens?: number };
  verified: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "ollama-local", name: "Ollama (on your computer)", tier: "local", protocol: "anthropic",
    baseURL: "http://localhost:11434", auth: "none", pricingUrl: "https://ollama.com/pricing",
    summary: "Runs on your own machine: free, private, no limits except your hardware.",
    limits: "Unlimited. Speed and model size depend on your GPU and memory.",
    steps: ["Install Ollama from ollama.com/download and start it.", "Run `ollama pull qwen3-coder` (or any coding model you like).", "Add it here. No key is needed."],
    models: [{ id: "qwen3-coder", label: "Qwen3 Coder", coding: true, free: true, note: "The example model in Ollama's own Claude Code guide. Needs enough RAM or GPU." }],
    customModelHint: "Any model you pulled: use the name shown by `ollama list`.",
    verified: "2026-09-30: docs.ollama.com/api/anthropic-compatibility and ollama.com/pricing",
  },
  {
    id: "ollama-cloud", name: "Ollama Cloud", tier: "freemium", protocol: "anthropic",
    baseURL: "https://ollama.com", auth: "bearer", keyUrl: "https://ollama.com/settings/keys", pricingUrl: "https://ollama.com/pricing",
    summary: "Big open models hosted by Ollama. Free account = starter credits; pay-as-you-go after that.",
    limits: "Free accounts get a starter amount of usage on a smaller set of starter models, one request at a time. Buying credits unlocks every model.",
    privacy: "Ollama states that prompts and responses are never logged or used for training.",
    steps: ["Create an account and an API key at ollama.com/settings/keys.", "Add the provider here with that key (the address is https://ollama.com, not https://ollama.com/api).", "If a model answers with a plan or credit error it is not a starter model: choose another one or add credits."],
    models: [
      { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", coding: true, price: { in: 0.30, out: 1.20, cacheRead: 0.006 }, note: "Half price outside 12:00-18:00 UTC on weekdays." },
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash", coding: true, price: { in: 0.15, out: 0.50, cacheRead: 0.03 } },
      { id: "gpt-oss:120b", label: "GPT-OSS 120B", coding: true, price: { in: 0.15, out: 0.60, cacheRead: 0.014 } },
      { id: "gpt-oss:20b", label: "GPT-OSS 20B", price: { in: 0.07, out: 0.30, cacheRead: 0.035 } },
      { id: "nemotron-3-super", label: "Nemotron 3 Super", price: { in: 0.015, out: 0.60, cacheRead: 0.015 } },
      { id: "gemma4:31b", label: "Gemma 4 31B", price: { in: 0.14, out: 0.40, cacheRead: 0.05 } },
      { id: "minimax-m3", label: "MiniMax M3", coding: true, price: { in: 0.60, out: 2.40, cacheRead: 0.12 } },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", coding: true, price: { in: 0.95, out: 4.00, cacheRead: 0.19 } },
      { id: "deepseek-v4-pro:0813", label: "DeepSeek V4 Pro", coding: true, price: { in: 1.32, out: 3.96, cacheRead: 0.044 } },
      { id: "glm-5.3", label: "GLM 5.3", coding: true, price: { in: 1.40, out: 4.40, cacheRead: 0.26 } },
    ],
    verified: "2026-09-30: ollama.com/pricing (prices) and ollama.com/api/tags (model ids)",
  },
  {
    id: "openrouter", name: "OpenRouter (free models)", tier: "freemium", protocol: "anthropic",
    baseURL: "https://openrouter.ai/api", auth: "bearer", keyUrl: "https://openrouter.ai/keys", pricingUrl: "https://openrouter.ai/docs/api-reference/limits",
    summary: "One key for hundreds of models, including several with a :free ending.",
    limits: "Free models: 20 requests per minute, 50 requests per day (1,000 per day once you have bought at least $10 of credits).",
    privacy: "Free models can log prompts. If you turned on Zero Data Retention in openrouter.ai/settings/privacy, free models may be blocked (\"no endpoints available matching your guardrail\").",
    steps: ["Create a key at openrouter.ai/keys.", "Add the provider. A daily limit of 50 requests is set for you, so the router moves to the next model before the free quota is used up (raise it if you bought credits)."],
    models: [
      { id: "openrouter/free", label: "Free Models Router", free: true, note: "OpenRouter picks a free model for each request." },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", free: true, coding: true },
    ],
    customModelHint: "Free models end in :free. Copy the id from openrouter.ai/models?q=free.",
    suggestedLimits: { dailyRequests: 50 },
    verified: "2026-09-30: OpenRouter limits page as quoted in a 2026-07-25 comparison; model ids from earlier OpenRouter listings",
  },
  {
    id: "opencode-zen", name: "OpenCode Zen", tier: "freemium", protocol: "anthropic",
    baseURL: "https://opencode.ai/zen", auth: "both", keyUrl: "https://opencode.ai/zen",
    summary: "A curated gateway with some free models and paid ones behind one key.",
    limits: "Which models are free changes over time; the Zen dashboard lists today's free ones.",
    steps: ["Sign in at opencode.ai/zen, add billing details (needed to get a key even for free models) and copy the key.", "Add the provider here."],
    models: [
      { id: "big-pickle", label: "Big Pickle", free: true, coding: true },
      { id: "space-bunny-free", label: "Space Bunny (free)", free: true },
      { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)", free: true, coding: true },
    ],
    verified: "2026-09-30: model ids seen in your own routes.json and in OpenCode Zen listings; confirm in the dashboard",
  },
  {
    id: "zai", name: "Z.ai (GLM)", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.z.ai/api/anthropic", auth: "both", keyUrl: "https://z.ai/manage-apikey/apikey-list",
    summary: "GLM coding models. Flash models are reported to have a free tier; the others are low-cost.",
    limits: "Third-party lists report roughly 1,000 requests per day on the free Flash tier. Confirm in your Z.ai account.",
    steps: ["Create a key at z.ai/manage-apikey/apikey-list.", "Add the provider here."],
    models: [
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash", coding: true, note: "Flash tier." },
      { id: "glm-5.3", label: "GLM 5.3", coding: true },
    ],
    verified: "2026-09-30: endpoint from Z.ai's Anthropic-compatible docs as quoted by community guides; limits are third-party",
  },
  {
    id: "deepseek", name: "DeepSeek", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.deepseek.com/anthropic", auth: "both", keyUrl: "https://platform.deepseek.com/api_keys", pricingUrl: "https://platform.deepseek.com/pricing",
    summary: "Very low prices and a big discount for cached input, which suits coding agents.",
    limits: "Pay as you go. No free tier.",
    steps: ["Create a key at platform.deepseek.com/api_keys and add a small balance.", "Add the provider here."],
    models: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", coding: true, price: { in: 0.15, out: 0.60, cacheRead: 0.003, peak: true }, note: "Off-peak price; DeepSeek charges double in its peak hours (the router estimates that when 'peak' is on)." },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", coding: true, price: { in: 0.66, out: 1.98, cacheRead: 0.022, peak: true } },
    ],
    verified: "2026-09-30: ollama.com/pricing lists the same off-peak figures for these models; check platform.deepseek.com/pricing",
  },
  {
    id: "moonshot", name: "Moonshot (Kimi)", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.moonshot.ai/anthropic", auth: "both", keyUrl: "https://platform.moonshot.ai/console/api-keys",
    summary: "Kimi models with an official Anthropic-style endpoint.",
    steps: ["Create a key at platform.moonshot.ai/console/api-keys.", "Add the provider here and copy a current model id from the console."],
    models: [{ id: "kimi-k2.5", label: "Kimi K2.5", coding: true, note: "Id taken from a community guide; confirm in the console." }],
    customModelHint: "Copy the current id from platform.moonshot.ai.",
    verified: "2026-09-30: endpoint from community guides that quote Moonshot's docs; model id unconfirmed",
  },
  {
    id: "minimax", name: "MiniMax", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.minimax.io/anthropic", auth: "both",
    summary: "MiniMax M-series coding models with an Anthropic-style endpoint.",
    steps: ["Create a key in the MiniMax platform console.", "Add the provider here."],
    models: [{ id: "minimax-m2.7", label: "MiniMax M2.7", coding: true, note: "Id taken from a community guide; confirm in the console." }],
    verified: "2026-09-30: endpoint from community guides; model id unconfirmed",
  },
  {
    id: "qwen", name: "Alibaba Qwen (DashScope)", tier: "cheap", protocol: "anthropic",
    baseURL: "https://dashscope-intl.aliyuncs.com/apps/anthropic", auth: "both",
    summary: "Qwen models through Alibaba Cloud Model Studio's Anthropic-style endpoint (international).",
    steps: ["Create a DashScope key in Alibaba Cloud Model Studio.", "Add the provider here."],
    models: [{ id: "qwen3.6-plus", label: "Qwen 3.6 Plus", coding: true, note: "Id taken from a community guide; confirm in the console." }],
    verified: "2026-09-30: endpoint from community guides; model id unconfirmed",
  },
  {
    id: "groq", name: "Groq", tier: "free", protocol: "openai",
    baseURL: "https://api.groq.com/openai/v1", auth: "bearer", keyUrl: "https://console.groq.com/keys",
    summary: "Very fast open models. Free plan, no card. The router converts formats for you.",
    limits: "As published in July 2026: 30 requests/min; 1,000/day on the GPT-OSS models and 14,400/day on llama-3.1-8b-instant.",
    steps: ["Create a key at console.groq.com/keys.", "Add the provider. A daily limit of 1,000 requests is set for you."],
    models: [
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", free: true, coding: true, note: "Confirm the exact id in the Groq console." },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", free: true },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", free: true },
    ],
    suggestedLimits: { dailyRequests: 1000 },
    verified: "2026-09-30: limits quoted in a 2026-07-25 comparison of free tiers; endpoint from Groq's OpenAI-compatible docs",
  },
  {
    id: "cerebras", name: "Cerebras", tier: "free", protocol: "openai",
    baseURL: "https://api.cerebras.ai/v1", auth: "bearer", keyUrl: "https://cloud.cerebras.ai",
    summary: "Extremely fast inference with a free tier. The router converts formats for you.",
    limits: "Reported at about 1 million tokens per day (2026). The free model list changes often: it shrank to two models on 2026-05-31.",
    steps: ["Create a key at cloud.cerebras.ai.", "Add the provider, then type a model id that is in your dashboard today. A daily budget of 1M tokens is set for you."],
    models: [],
    customModelHint: "Copy a current model id from the Cerebras dashboard; do not reuse an old one.",
    suggestedLimits: { dailyTokens: 1_000_000 },
    verified: "2026-09-30: third-party free-tier comparisons (August 2026); endpoint from Cerebras docs as quoted by community lists",
  },
  {
    id: "gemini", name: "Google Gemini (AI Studio)", tier: "free", protocol: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer", keyUrl: "https://aistudio.google.com/apikey",
    summary: "Gemini models with a free tier, through Google's OpenAI-compatible endpoint.",
    limits: "Limits apply per project; AI Studio shows the exact numbers for yours.",
    privacy: "On the free tier Google may use your prompts to improve its models (not in the EU, UK or EEA).",
    steps: ["Create a key at aistudio.google.com/apikey.", "Add the provider, then type a Gemini model id from AI Studio (a Flash model is the usual free choice)."],
    models: [],
    customModelHint: "Copy a current Gemini model id from AI Studio.",
    verified: "2026-09-30: ai.google.dev/gemini-api/docs/openai (address); privacy note from a 2026 free-tier comparison",
  },
  {
    id: "nvidia-nim", name: "NVIDIA NIM", tier: "free", protocol: "openai",
    baseURL: "https://integrate.api.nvidia.com/v1", auth: "bearer", keyUrl: "https://build.nvidia.com",
    summary: "Many hosted models with a free developer tier.",
    limits: "Reported at about 40 requests per minute, with phone verification (third-party lists, 2026).",
    steps: ["Create a key at build.nvidia.com.", "Add the provider, then type a model id from the catalog there."],
    models: [],
    customModelHint: "Copy the model id from the model's page on build.nvidia.com.",
    verified: "2026-09-30: third-party free-tier lists (2026); endpoint as listed there",
  },
  {
    id: "mistral", name: "Mistral (La Plateforme)", tier: "free", protocol: "openai",
    baseURL: "https://api.mistral.ai/v1", auth: "bearer", keyUrl: "https://console.mistral.ai/api-keys",
    summary: "Mistral's own models, with a free Experiment tier.",
    privacy: "The free Experiment tier requires you to opt in to training on your data.",
    steps: ["Create a key at console.mistral.ai/api-keys.", "Add the provider, then type a model id from Mistral's model list."],
    models: [],
    customModelHint: "Copy a current model id from docs.mistral.ai.",
    verified: "2026-09-30: OpenRouter's 2026 free-tier comparison and Mistral's OpenAI-compatible address as quoted there",
  },
];
````

### `scripts/providers-smoke.mjs` — NEW file

````js
// Offline test: OpenAI-style providers, the catalog, and address mistakes (Ollama /api).
// Run: npm run build && node scripts/providers-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-providers-"));
const PORT = 21990;

// ---- mock OpenAI-style upstream (/chat/completions) and mock Anthropic-style upstream (/v1/messages)
let lastOpenAI = null;
let openAIFail = 0; // answer 429 this many times
const sse = (res, chunks) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const c of chunks) res.write(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`); res.end(); };
const oa = http.createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":{"message":"path not found"}}'); }
    const body = JSON.parse(data || "{}");
    lastOpenAI = { auth: req.headers.authorization ?? null, xkey: req.headers["x-api-key"] ?? null, body };
    if (openAIFail > 0) { openAIFail--; res.writeHead(429, { "content-type": "application/json" }); return res.end('{"error":{"message":"Insufficient balance, please recharge"}}'); }
    const tools = Array.isArray(body.tools) && body.tools.length;
    const lastUser = body.messages[body.messages.length - 1];
    if (body.stream) {
      if (tools && /weather/i.test(JSON.stringify(body.messages)) && lastUser.role !== "tool") {
        return sse(res, [
          { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Let me check. " } }] },
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Dhaka"}' } }] } }] },
          { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { id: "c1", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
          "[DONE]",
        ]);
      }
      return sse(res, [
        { id: "c2", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
        { id: "c2", choices: [{ index: 0, delta: { content: " world" } }] },
        { id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "c2", choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } },
        "[DONE]",
      ]);
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (tools && lastUser.role !== "tool" && /weather/i.test(JSON.stringify(body.messages))) {
      return res.end(JSON.stringify({ id: "x1", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Dhaka"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 12 } }));
    }
    res.end(JSON.stringify({ id: "x2", choices: [{ message: { role: "assistant", content: "Sunny in Dhaka. " + "summary ".repeat(12) }, finish_reason: "stop" }], usage: { prompt_tokens: 90, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } }));
  });
});
await new Promise((r) => oa.listen(0, "127.0.0.1", r));
let lastAnth = null;
const an = http.createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c));
  req.on("end", () => {
    lastAnth = { url: req.url, auth: req.headers.authorization ?? null, xkey: req.headers["x-api-key"] ?? null };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "from anthropic-style" }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});
await new Promise((r) => an.listen(0, "127.0.0.1", r));
const oaBase = `http://127.0.0.1:${oa.address().port}/v1`;
const anBase = `http://127.0.0.1:${an.address().port}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "free", aliases: {},
  providers: {
    groq: { baseURL: oaBase, protocol: "openai", auth: "bearer", keys: ["GROQ_KEY_1"] },
    anth: { baseURL: anBase, auth: "both", keys: ["ANTH_KEY_1"] },
  },
  models: {
    free: { provider: "groq", model: "gpt-oss-up", key: "GROQ_KEY_1", fallback: ["paid"] },
    paid: { provider: "anth", model: "claude-like", key: "ANTH_KEY_1" },
  },
}));
fs.writeFileSync(path.join(home, ".env"), `ROUTER_PORT=${PORT}\nROUTER_KEY="secret-router"\nGROQ_KEY_1=gsk-test-1111\nANTH_KEY_1=an-test-2222\n`);
const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1300));
const R = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-api-key": "secret-router", origin: R };
const post = (body) => fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ max_tokens: 100, ...body }) });
const admin = (p, init = {}) => fetch(R + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
const version = async () => (await (await admin("/admin/models")).json()).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const t = (n, ok, x = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!ok) fails++; };
const events = (txt) => txt.split("\n\n").filter(Boolean).map((b) => { const ev = b.match(/^event: (.+)$/m)?.[1]; const d = JSON.parse(b.match(/^data: (.+)$/m)[1]); return { ev, d }; });

const tools = [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

// ---------- 1. plain request to an OpenAI-style provider
let r = await post({ model: "free", system: [{ type: "text", text: "You are helpful." }], messages: [{ role: "user", content: [{ type: "text", text: "hi there" }] }], temperature: 0.2, stop_sequences: ["END"], thinking: { type: "enabled", budget_tokens: 100 } });
let j = await r.json();
t("OpenAI-style provider answers in Claude's format", r.status === 200 && j.type === "message" && j.role === "assistant" && /Sunny in Dhaka/.test(j.content[0].text) && j.stop_reason === "end_turn");
t("usage converted (cached tokens split out)", j.usage.input_tokens === 60 && j.usage.cache_read_input_tokens === 30 && j.usage.output_tokens === 20, JSON.stringify(j.usage));
const sent = lastOpenAI.body;
t("request converted: model, system message, user text, max_tokens, temperature, stop", sent.model === "gpt-oss-up" && sent.messages[0].role === "system" && sent.messages[0].content === "You are helpful." && sent.messages[1].content === "hi there" && sent.max_tokens === 100 && sent.temperature === 0.2 && sent.stop[0] === "END");
t("Claude-only fields are not sent (thinking, metadata)", sent.thinking === undefined && sent.metadata === undefined);
t("sent with Bearer only (no x-api-key)", lastOpenAI.auth === "Bearer gsk-test-1111" && lastOpenAI.xkey === null);

// ---------- 2. tool call round trip (non-streaming)
const toolConv = [{ role: "user", content: "What is the weather in Dhaka?" }];
r = await post({ model: "free", tools, tool_choice: { type: "auto" }, messages: toolConv });
j = await r.json();
const tu = j.content.find((b) => b.type === "tool_use");
t("tool call comes back as a tool_use block with parsed input", tu && tu.name === "get_weather" && tu.input.city === "Dhaka" && tu.id === "call_1" && j.stop_reason === "tool_use");
t("tools sent as functions with the schema, tool_choice auto", lastOpenAI.body.tools[0].type === "function" && lastOpenAI.body.tools[0].function.parameters.required[0] === "city" && lastOpenAI.body.tool_choice === "auto");
r = await post({ model: "free", tools, messages: [...toolConv, { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Dhaka" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "31 C, sunny" }, { type: "text", text: "thanks" }] }] });
await r.json();
const m2 = lastOpenAI.body.messages;
const ai = m2.findIndex((x) => x.role === "assistant");
t("tool call + tool result converted in the right order", m2[ai].tool_calls[0].function.arguments === '{"city":"Dhaka"}' && m2[ai + 1].role === "tool" && m2[ai + 1].tool_call_id === "call_1" && m2[ai + 1].content === "31 C, sunny" && m2[ai + 2].role === "user" && m2[ai + 2].content === "thanks", JSON.stringify(m2.map((x) => x.role)));

// ---------- 3. streaming
r = await post({ model: "free", stream: true, messages: [{ role: "user", content: "say hello" }] });
let ev = events(await r.text());
t("stream: same event order as Claude's API", ev.map((e) => e.ev).join(",") === "message_start,content_block_start,content_block_delta,content_block_delta,content_block_stop,message_delta,message_stop", ev.map((e) => e.ev).join(","));
t("stream: text arrives as text_delta pieces", ev.filter((e) => e.ev === "content_block_delta").map((e) => e.d.delta.text).join("") === "Hello world");
t("stream: stop reason and usage", ev.at(-2).d.delta.stop_reason === "end_turn" && ev.at(-2).d.usage.output_tokens === 2 && ev.at(-2).d.usage.input_tokens === 50);
t("stream: include_usage was requested", lastOpenAI.body.stream === true && lastOpenAI.body.stream_options.include_usage === true);
r = await post({ model: "free", stream: true, tools, messages: [{ role: "user", content: "weather in Dhaka please" }] });
ev = events(await r.text());
const starts = ev.filter((e) => e.ev === "content_block_start");
t("stream with tool call: a text block then a tool_use block", starts.length === 2 && starts[0].d.content_block.type === "text" && starts[1].d.content_block.type === "tool_use" && starts[1].d.content_block.id === "call_abc" && starts[1].d.content_block.name === "get_weather");
t("stream with tool call: arguments arrive as input_json_delta that joins to valid JSON", JSON.parse(ev.filter((e) => e.d.delta?.type === "input_json_delta").map((e) => e.d.delta.partial_json).join("")).city === "Dhaka");
t("stream with tool call: stop_reason tool_use, cache split", ev.at(-2).d.delta.stop_reason === "tool_use" && ev.at(-2).d.usage.cache_read_input_tokens === 100 && ev.at(-2).d.usage.input_tokens === 20);
t("stream: blocks are closed before the next opens", (() => { let open = -1; for (const e of ev) { if (e.ev === "content_block_start") { if (open !== -1) return false; open = e.d.index; } if (e.ev === "content_block_stop") { if (open !== e.d.index) return false; open = -1; } } return open === -1; })());

// ---------- 4. history + failover from an OpenAI-style provider to an Anthropic-style one
await sleep(300);
let rows = (await (await admin("/admin/requests?limit=3&q=free")).json()).rows;
t("history records tokens for OpenAI-style requests", rows.length && rows[0].in >= 0 && rows[0].provider === "groq");
openAIFail = 1;
r = await post({ model: "free", messages: [{ role: "user", content: "hi" }] });
j = await r.json();
t("free provider out of balance: falls over to the Anthropic-style provider", r.status === 200 && j.content[0].text === "from anthropic-style" && r.headers.get("x-router-served") === "paid");
t("... and the Anthropic-style provider was called the normal way", lastAnth.url === "/v1/messages" && lastAnth.auth === "Bearer an-test-2222" && lastAnth.xkey === "an-test-2222");
await sleep(250);
rows = (await (await admin("/admin/requests?limit=1")).json()).rows;
t("... and the reason is in the trace", rows[0].trace.some((x) => x.outcome === "failed" && /Insufficient balance/.test(x.detail ?? "")));

// ---------- 5. connection test works for both protocols and gives hints
await admin("/admin/keys/GROQ_KEY_1/reset-cooldown", { method: "POST", body: "{}" });
let tr = await (await admin("/admin/models/free/test", { method: "POST", body: JSON.stringify({ confirm: true }) })).json();
t("model test works on an OpenAI-style provider", tr.ok === true && tr.status === 200, JSON.stringify({ ok: tr.ok, status: tr.status }));

// ---------- 6. address mistakes are refused, with the reason
let v = await version();
const put = (name, b) => admin("/admin/providers/" + name, { method: "PUT", body: JSON.stringify({ version: v, ...b }) });
let pr = await put("anth", { baseURL: anBase + "/v1" });
t("Anthropic-style address ending in /v1 is refused", pr.status === 400 && /remove \/v1/.test(await pr.text()));
pr = await put("anth", { baseURL: anBase + "/v1/messages" });
t("address ending in /v1/messages is refused", pr.status === 400 && /adds the final part itself/.test(await pr.text()));
pr = await put("groq", { baseURL: oaBase + "/chat/completions" });
t("address ending in /chat/completions is refused", pr.status === 400);
pr = await admin("/admin/providers", { method: "POST", body: JSON.stringify({ version: v, name: "ollama", baseURL: "https://ollama.com/api", auth: "bearer" }) });
t("the Ollama mistake (https://ollama.com/api) is refused with the right address", pr.status === 400 && /https:\/\/ollama\.com \(without \/api\)/.test(await pr.text()));
pr = await put("groq", { baseURL: oaBase, protocol: "banana" });
t("unknown protocol refused", pr.status === 400);
pr = await put("anth", { protocol: "openai", baseURL: anBase + "/v1" });
t("OpenAI-style address may end in /v1", pr.status === 200);
v = await version();
pr = await put("anth", { protocol: "anthropic", baseURL: anBase });
t("switching back works", pr.status === 200);

// ---------- 7. catalog
let cat = await (await admin("/admin/catalog")).json();
t("catalog lists the providers with protocol, address and where to get a key", cat.entries.length >= 12 && cat.entries.every((e) => e.baseURL && e.protocol && e.steps.length && e.verified) && cat.entries.some((e) => e.tier === "free") && cat.entries.some((e) => e.tier === "cheap"));
const ollama = cat.entries.find((e) => e.id === "ollama-cloud");
t("catalog has the correct Ollama cloud address and no /api", ollama.baseURL === "https://ollama.com" && ollama.auth === "bearer");
t("every catalog address passes the router's own address check", cat.entries.every((e) => !/\/v1\/messages$|\/chat\/completions$/.test(e.baseURL)) && cat.entries.filter((e) => e.protocol === "anthropic").every((e) => !/\/v1$/.test(e.baseURL)));
v = cat.version;
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: v, id: "ollama-cloud", key: "ollama-secret-7777", models: [{ id: "deepseek-v4.1-flash" }, { id: "glm-5.3-flash", alias: "my-glm-flash" }] }) });
let aj = await pr.json();
t("add from catalog: provider + key + 2 models in one save", pr.status === 201 && aj.provider.name === "ollama-cloud" && aj.models.length === 2 && aj.models.includes("my-glm-flash"), JSON.stringify({ s: pr.status, m: aj.models }));
t("... key stored in .env, pool updated, secret not echoed", fs.readFileSync(path.join(home, ".env"), "utf8").includes("OLLAMA_CLOUD_KEY_1=ollama-secret-7777") && aj.provider.keys[0].envName === "OLLAMA_CLOUD_KEY_1" && !JSON.stringify(aj).includes("ollama-secret-7777"));
const mods = (await (await admin("/admin/models")).json()).models;
const dsm = mods.find((m) => m.model === "deepseek-v4.1-flash");
t("... models created with catalog prices", dsm.price && dsm.price.in === 0.30 && dsm.price.out === 1.20 && dsm.alias === "deepseek-v4.1-flash");
cat = await (await admin("/admin/catalog")).json();
t("catalog now shows it as installed with its models", cat.entries.find((e) => e.id === "ollama-cloud").installed === "ollama-cloud" && cat.entries.find((e) => e.id === "ollama-cloud").addedModels.includes("glm-5.3-flash"));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: cat.version, id: "ollama-cloud", models: ["deepseek-v4.1-flash"] }) });
aj = await pr.json();
t("adding the same model again gets a fresh alias, provider reused", pr.status === 201 && aj.models[0] === "deepseek-v4.1-flash-2" && aj.provider.keys.length === 1);
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: (await version()), id: "openrouter", models: ["openrouter/free"] }) });
aj = await pr.json();
t("free tier suggestion applied: OpenRouter gets a daily limit of 50 requests", pr.status === 201 && aj.provider.dailyRequests === 50 && /No key yet/.test(aj.warning ?? ""), JSON.stringify({ d: aj.provider?.dailyRequests, w: aj.warning }));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "groq", providerName: "groq2", key: "gsk-second-3333", models: ["openai/gpt-oss-120b"] }) });
aj = await pr.json();
t("OpenAI-style catalog entry creates an openai-protocol provider", pr.status === 201 && aj.provider.protocol === "openai" && aj.provider.baseURL === "https://api.groq.com/openai/v1");
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "groq", providerName: "groq", models: ["x"] }) });
t("a provider name already used for a different address is refused", pr.status === 400 && /already exists with another address/.test(await pr.text()));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "ollama-local", key: "abcdefgh", models: ["qwen3-coder"] }) });
t("keyless provider refuses a key", pr.status === 400 && /needs no key/.test(await pr.text()));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "ollama-local", models: ["qwen3-coder"] }) });
aj = await pr.json();
t("Ollama on your computer: no key needed, created with auth none", pr.status === 201 && aj.provider.keyless === true && aj.warning === null, JSON.stringify({ s: pr.status, k: aj.provider?.keyless }));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "nope", models: ["x"] }) });
t("unknown catalog entry -> 404", pr.status === 404);
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "gemini", models: [] }) });
t("no model chosen -> clear error", pr.status === 400 && /choose at least one model/.test(await pr.text()));
const after = (await (await admin("/admin/models")).json()).models.map((m) => m.alias);
t("failed adds left nothing behind", !after.includes("x") && !(await (await admin("/admin/providers")).json()).providers.some((p) => p.name === "gemini"));

// ---------- 8. a free OpenAI-style model can be the one that writes the memory summaries
await admin("/admin/keys/GROQ_KEY_1/reset-cooldown", { method: "POST", body: "{}" });
pr = await admin("/admin/app-settings", { method: "PUT", body: JSON.stringify({ settings: { "memory.model": "free", "memory.mode": "on", "memory.highTokens": 30000, "memory.lowTokens": 12000, "guard.mode": "off" } }) });
t("memory can be pointed at an OpenAI-style model", pr.status === 200);
const long = [{ role: "user", content: [{ type: "text", text: "Refactor the billing module." }] }];
for (let i = 0; i < 40; i++) {
  long.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file_path: `/src/f${i}.ts` } }] });
  long.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "z".repeat(5000) }] });
}
await post({ model: "paid", system: "S".repeat(4000), messages: long, metadata: { user_id: "prov-mem" } });
await sleep(900);
const mem = await (await admin("/admin/memory")).json();
t("summary written through the OpenAI-style provider and stored", mem.summaries.length === 1 && mem.summaries[0].model === "free" && /Sunny in Dhaka/.test(mem.summaries[0].summary) && /Original request:\nRefactor the billing module/.test(mem.summaries[0].summary));
t("the summariser request was converted (system + user text, no Claude-only fields)", lastOpenAI.body.messages[0].role === "system" && lastOpenAI.body.messages[1].role === "user" && lastOpenAI.body.stream === undefined);

child.kill();
fs.rmSync(home, { recursive: true, force: true });
oa.close(); an.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
````

### Step 2 — Apply these diffs

### `src/config.ts` — provider protocol, address checks

````diff
--- a/src/config.ts
+++ b/src/config.ts
@@ -34,8 +34,12 @@
 // ---------- config shape ----------
 export type AuthMode = "bearer" | "x-api-key" | "both" | "none";
 
+export type Protocol = "anthropic" | "openai";
+
 export interface ProviderCfg {
   baseURL: string;
+  /** anthropic (default): the provider speaks Claude's Messages API. openai: it speaks chat completions and the router converts. */
+  protocol?: Protocol;
   auth: AuthMode;
   keys: string[]; // env var NAMES, not the secrets
   dropBeta?: boolean;
@@ -275,6 +279,23 @@
   return value;
 }
 
+/** Catches the classic address mistakes before they turn into a 404. Returns a message or null. */
+export function baseURLProblem(baseURL: string, protocol: Protocol): string | null {
+  let u: URL;
+  try { u = new URL(baseURL); } catch { return null; }
+  const path = u.pathname.replace(/\/+$/, "");
+  if (/\/v1\/messages$/.test(path) || /\/chat\/completions$/.test(path)) {
+    return "remove /v1/messages or /chat/completions from the end: the router adds the final part itself";
+  }
+  if (protocol === "anthropic" && /\/v1$/.test(path)) {
+    return "remove /v1 from the end: for an Anthropic-style provider the router adds /v1/messages itself";
+  }
+  if (u.hostname === "ollama.com" && path === "/api") {
+    return "Ollama cloud's Anthropic-style address is https://ollama.com (without /api); /api only serves Ollama's own format";
+  }
+  return null;
+}
+
 export function validateProviderName(raw: unknown): string {
   if (typeof raw !== "string" || !PROVIDER_RE.test(raw)) {
     throw new ValidationError([
@@ -326,6 +347,17 @@
     }
   }
 
+  let protocol: Protocol = existing?.protocol ?? "anthropic";
+  if (body.protocol !== undefined) {
+    if (body.protocol !== "anthropic" && body.protocol !== "openai") {
+      errors.push({ field: "protocol", message: "must be anthropic or openai" });
+    } else protocol = body.protocol;
+  }
+  {
+    const problem = baseURL ? baseURLProblem(baseURL, protocol) : null;
+    if (problem) errors.push({ field: "baseURL", message: problem });
+  }
+
   const dropBeta =
     body.dropBeta === undefined ? !!existing?.dropBeta : body.dropBeta === true || body.dropBeta === "true";
   const disabled =
@@ -347,6 +379,7 @@
 
   if (errors.length) throw new ValidationError(errors);
   const out: ProviderCfg = { baseURL, auth, keys: existing?.keys ?? [], dropBeta, dropBodyFields, disabled };
+  if (protocol === "openai") out.protocol = "openai";
   if (dailyRequests !== undefined) out.dailyRequests = dailyRequests;
   if (dailyTokens !== undefined) out.dailyTokens = dailyTokens;
   return out;
````

### `src/index.ts` — call OpenAI-style providers and convert the answer

````diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -7,7 +7,7 @@
 import { Config, ModelCfg, PORT, ProviderCfg, ROOT, ROUTER_KEY, getCfg } from "./config";
 import { handleAdmin, hostAllowed, originAllowed } from "./admin";
 import { promptAnatomy } from "./anatomy";
-import { applyGuard, pruneGuardMemory } from "./contextGuard";
+import { applyGuard, estimateTokens, pruneGuardMemory } from "./contextGuard";
 import { applyMemory, pruneMemory } from "./memory";
 import { canWrite, handleAuthRoutes, headerKeyOk, principal, seedAdminFromEnv, userCount } from "./auth";
 import * as history from "./history";
@@ -16,6 +16,7 @@
 import { costOf } from "./pricing";
 import { budgetReason, fitToWindow } from "./capacity";
 import { classifyFailure } from "./failure";
+import { adaptOpenAI, openaiHeaders, toOpenAIRequest } from "./openai";
 import { getSetting } from "./db";
 import { buildBody, buildHeaders, keyOrder, resolveModel } from "./routing";
 
@@ -343,6 +344,7 @@
       addTrace({ route: routeName, outcome: "skipped", detail: p ? `provider ${m.provider} is disabled` : `provider ${m.provider} does not exist` });
       continue;
     }
+    const isOpenAI = p.protocol === "openai";
     const spent = budgetReason(m.provider, p);
     if (spent) {
       addTrace({ route: routeName, outcome: "skipped", detail: `${m.provider}: ${spent}` });
@@ -380,10 +382,10 @@
       for (let attempt = 0; ; attempt++) {
         let up: Response;
         try {
-          up = await fetch(`${p.baseURL}/v1/messages`, {
+          up = await fetch(isOpenAI ? `${p.baseURL}/chat/completions` : `${p.baseURL}/v1/messages`, {
             method: "POST",
-            headers: buildHeaders(req, p, keyName),
-            body: buildBody(fit.body, m, p),
+            headers: isOpenAI ? openaiHeaders(p, keyName) : buildHeaders(req, p, keyName),
+            body: isOpenAI ? toOpenAIRequest(fit.body, m, p) : buildBody(fit.body, m, p),
             signal: ac.signal,
           });
         } catch (e) {
@@ -426,7 +428,9 @@
         addTrace({ route: routeName, key: keyName, outcome: "served", status: up.status, detail: fit.note });
         if (fit.saved > 0 && track) track.guardSaved = (track.guardSaved ?? 0) + fit.saved;
         if (routeName !== alias) console.warn(`[ROUTER] asked "${body.model}" (${alias}) but served by ${routeName}: ${summary()}`);
-        return relay(up, res, body, routeName, m, keyName, started, track);
+        // An OpenAI-style provider answers in its own format: convert it, then everything below is unchanged.
+        const answer = isOpenAI ? await adaptOpenAI(up, body.stream === true, m.model, estimateTokens(fit.body)) : up;
+        return relay(answer, res, body, routeName, m, keyName, started, track);
       }
     }
   }
````

### `src/admin.ts` — protocol in provider view, hints on failed tests, catalog endpoints

````diff
--- a/src/admin.ts
+++ b/src/admin.ts
@@ -12,6 +12,8 @@
 import { DATA_DIR, DB_FILE, SETTING_DEFAULTS, allSettings, db, setSetting } from "./db";
 import { userCount } from "./auth";
 import { budgetReason } from "./capacity";
+import { openaiHeaders, toOpenAIRequest } from "./openai";
+import { CATALOG } from "./catalog";
 import { clearMemory, deleteMemory, listMemory } from "./memory";
 import * as history from "./history";
 import {
@@ -111,6 +113,18 @@
   };
 }
 
+/** Plain-language next step for a failed connection test. */
+function testHint(status: number, detail: string, baseURL: string, protocol: string): string | null {
+  const url = protocol === "openai" ? `${baseURL}/chat/completions` : `${baseURL}/v1/messages`;
+  if (status === 404 && /path|not found|404|no route/i.test(detail)) {
+    return `The address looks wrong: the router called ${url} and the server does not have it. Fix the Base URL in Providers > Edit (do not add /v1/messages yourself; for Ollama cloud use https://ollama.com).`;
+  }
+  if (status === 401 || status === 403) return "The provider refused the key. Check that the key is the right one for this provider and not expired, and that Auth mode matches (Ollama cloud needs bearer or both).";
+  if (status === 402 || status === 429) return "The provider says no balance, no free credits left, or too many requests. Check the provider's usage page; free plans often allow only some models.";
+  if (status === 400 && /model/i.test(detail)) return "The provider does not know this model id. Copy the exact id from the provider's model list.";
+  return null;
+}
+
 function providerView(name: string, p: ProviderCfg) {
   const keyless = p.auth === "none";
   const keys = p.keys.map(keyView);
@@ -119,6 +133,7 @@
     name,
     baseURL: p.baseURL,
     auth: p.auth,
+    protocol: p.protocol ?? "anthropic",
     dropBeta: !!p.dropBeta,
     dropBodyFields: p.dropBodyFields ?? [],
     disabled: !!p.disabled,
@@ -945,10 +960,12 @@
   const ac = new AbortController();
   const timer = setTimeout(() => ac.abort(), 20000);
   try {
-    const up = await fetch(`${p.baseURL}/v1/messages`, {
+    const isOpenAI = p.protocol === "openai";
+    const probe = { model: m.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
+    const up = await fetch(isOpenAI ? `${p.baseURL}/chat/completions` : `${p.baseURL}/v1/messages`, {
       method: "POST",
-      headers: buildHeaders(req, p, keyName),
-      body: JSON.stringify({ model: m.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
+      headers: isOpenAI ? openaiHeaders(p, keyName) : buildHeaders(req, p, keyName),
+      body: isOpenAI ? toOpenAIRequest(probe, m, p) : JSON.stringify(probe),
       signal: ac.signal,
     });
     const text = await up.text();
@@ -968,6 +985,7 @@
       model: m.model,
       key: keyView(keyName),
       detail,
+      hint: up.ok ? null : testHint(up.status, detail, p.baseURL, p.protocol ?? "anthropic"),
     });
   } catch (e) {
     sendJSON(res, 200, {
@@ -1100,6 +1118,102 @@
   sendJSON(res, 200, { deleted: deleteMemory(decodeURIComponent(session)) });
 });
 
+// ---------- provider catalog: add a known provider and its models in one save ----------
+const normURL = (u: string): string => u.trim().replace(/\/+$/, "").toLowerCase();
+
+on("GET", /^\/admin\/catalog$/, (_req, res) => {
+  const c = getCfg();
+  const entries = CATALOG.map((e) => {
+    const installed = Object.entries(c.providers).find(([, p]) => normURL(p.baseURL) === normURL(e.baseURL))?.[0] ?? null;
+    const have = installed ? Object.values(c.models).filter((m) => m.provider === installed).map((m) => m.model) : [];
+    return { ...e, installed, addedModels: have };
+  });
+  sendJSON(res, 200, { version: configVersion(), envVersion: envVersion(), entries });
+});
+
+on("POST", /^\/admin\/catalog\/add$/, async (req, res) => {
+  const body = await readJSONBody(req);
+  const version = expectVersion(body);
+  const entry = CATALOG.find((e) => e.id === body.id);
+  if (!entry) return fail(res, 404, "not_found_error", `No catalog entry "${String(body.id)}"`);
+  const c = getCfg();
+  const errors: { field: string; message: string }[] = [];
+
+  // which router provider receives the models
+  const sameURL = Object.entries(c.providers).find(([, p]) => normURL(p.baseURL) === normURL(entry.baseURL))?.[0];
+  const name = typeof body.providerName === "string" && body.providerName.trim() ? validateProviderName(body.providerName.trim()) : sameURL ?? entry.id;
+  let existing = c.providers[name];
+  if (existing && normURL(existing.baseURL) !== normURL(entry.baseURL)) {
+    throw new ValidationError([{ field: "providerName", message: `"${name}" already exists with another address (${existing.baseURL}). Choose a different name.` }]);
+  }
+  let cfg: Config = c;
+  if (!existing) {
+    const created = validateProviderBody({
+      baseURL: entry.baseURL, auth: entry.auth, protocol: entry.protocol,
+      ...(entry.suggestedLimits?.dailyRequests ? { dailyRequests: entry.suggestedLimits.dailyRequests } : {}),
+      ...(entry.suggestedLimits?.dailyTokens ? { dailyTokens: entry.suggestedLimits.dailyTokens } : {}),
+    });
+    cfg = { ...c, providers: { ...c.providers, [name]: { ...created, keys: [] } } };
+    existing = cfg.providers[name];
+  }
+
+  // the key (optional here; it can be attached later)
+  let env: Record<string, string> | undefined;
+  let envName = "";
+  const value = typeof body.key === "string" ? body.key.trim() : "";
+  if (value) {
+    if (entry.auth === "none") errors.push({ field: "key", message: `${entry.name} needs no key` });
+    else if (value.length < 4) errors.push({ field: "key", message: "paste the API key (at least 4 characters)" });
+    else {
+      const owner = new Set<string>();
+      for (const pv of Object.values(cfg.providers)) for (const k of pv.keys) owner.add(k);
+      const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
+      let n = 1;
+      while (owner.has(`${base}_KEY_${n}`)) n++;
+      envName = `${base}_KEY_${n}`;
+      cfg = { ...cfg, providers: { ...cfg.providers, [name]: { ...cfg.providers[name], keys: [...cfg.providers[name].keys, envName] } } };
+      env = { [envName]: value };
+    }
+  }
+
+  // the models
+  const wanted = Array.isArray(body.models) ? body.models : [];
+  if (!wanted.length) errors.push({ field: "models", message: "choose at least one model, or type a model id" });
+  const created: string[] = [];
+  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 56) || "model";
+  wanted.forEach((w: unknown, i: number) => {
+    const r = (typeof w === "string" ? { id: w } : (w ?? {})) as Record<string, unknown>;
+    const id = typeof r.id === "string" ? r.id.trim() : "";
+    if (!id || id.length > 200) { errors.push({ field: `models.${i}.id`, message: "model id is required" }); return; }
+    const known = entry.models.find((m) => m.id === id);
+    let alias = typeof r.alias === "string" && r.alias.trim() ? r.alias.trim() : slug(id);
+    if (!(typeof r.alias === "string" && r.alias.trim())) {
+      let n = 2;
+      const first = alias;
+      while (cfg.models[alias]) alias = `${first}-${n++}`;
+    }
+    try {
+      validateModelAlias(alias);
+      if (cfg.models[alias]) throw new ValidationError([{ field: `models.${i}.alias`, message: `"${alias}" already exists` }]);
+      const m = validateModelBody({ provider: name, model: id, ...(known?.price ? { price: known.price } : {}) }, cfg);
+      cfg = { ...cfg, models: { ...cfg.models, [alias]: m } };
+      created.push(alias);
+    } catch (e) {
+      errors.push(...(e as ValidationError).errors.map((x) => ({ ...x, field: x.field.startsWith("models") ? x.field : `models.${i}.${x.field}` })));
+    }
+  });
+  if (errors.length) throw new ValidationError(errors);
+
+  commit(cfg, version);
+  if (env) {
+    commitEnv(env, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
+    resetCooldown(envName);
+  }
+  const warning = entry.auth !== "none" && !getCfg().providers[name].keys.some((k) => process.env[k])
+    ? "No key yet: open Providers > Keys and paste one, or these models will say NO KEY." : null;
+  sendJSON(res, 201, { version: configVersion(), envVersion: envVersion(), provider: providerView(name, getCfg().providers[name]), models: created, warning });
+});
+
 on("GET", /^\/admin\/app-settings$/, (_req, res) => sendJSON(res, 200, { settings: allSettings() }));
 
 on("PUT", /^\/admin\/app-settings$/, async (req, res) => {
````

### `src/memory.ts` — summary model may be an OpenAI-style provider

````diff
--- a/src/memory.ts
+++ b/src/memory.ts
@@ -5,6 +5,7 @@
 import { costOf } from "./pricing";
 import { db, getSetting } from "./db";
 import * as history from "./history";
+import { callOnce } from "./openai";
 import { buildBody, buildHeaders, keyOrder } from "./routing";
 import type { InFlight, RecentEntry } from "./live";
 import * as live from "./live";
@@ -194,13 +195,19 @@
   const key = keyOrder(p, m, "memory").find((k) => live.cooldownLeft(k) === 0);
   if (!key) throw new Error(`no usable key for memory model "${alias}"`);
   const started = Date.now();
-  const body = buildBody({ model: alias, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content: prompt }], stream: false }, m, p);
+  const payload = { model: alias, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content: prompt }], stream: false };
+  let status: number, raw: string, j: Json;
+  if (p.protocol === "openai") {
+    const r = await callOnce(m, p, key, payload, AbortSignal.timeout(90_000));
+    status = r.status; raw = r.raw; j = r.json;
+  } else {
   const res = await fetch(`${p.baseURL}/v1/messages`, {
-    method: "POST", headers: buildHeaders(fakeReq, p, key), body, signal: AbortSignal.timeout(90_000),
+      method: "POST", headers: buildHeaders(fakeReq, p, key), body: buildBody(payload, m, p), signal: AbortSignal.timeout(90_000),
   });
-  const raw = await res.text();
-  if (!res.ok) throw new Error(`HTTP ${res.status} from ${m.provider}: ${raw.slice(0, 120).replace(/[A-Za-z0-9_-]{28,}/g, "[redacted]")}`);
-  const j = JSON.parse(raw);
+    status = res.status; raw = await res.text();
+    j = res.ok ? JSON.parse(raw) : null;
+  }
+  if (status < 200 || status >= 300 || !j) throw new Error(`HTTP ${status} from ${m.provider}: ${raw.slice(0, 120).replace(/[A-Za-z0-9_-]{28,}/g, "[redacted]")}`);
   const text = (Array.isArray(j.content) ? j.content : []).filter((b: Json) => b?.type === "text").map((b: Json) => String(b.text ?? "")).join("\n").trim();
   if (text.length < 40) throw new Error("the memory model returned no usable summary");
   const us = j.usage ?? {};
````

### `package.json` — npm script smoke:providers

````diff
--- a/package.json
+++ b/package.json
@@ -13,11 +13,12 @@
     "check": "tsc --noEmit",
     "smoke": "npm run -s build && node scripts/smoke.mjs",
     "smoke:admin": "npm run -s build && node scripts/admin-smoke.mjs",
-    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing && npm run -s smoke:capacity && npm run -s smoke:memory",
+    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing && npm run -s smoke:capacity && npm run -s smoke:memory && npm run -s smoke:providers",
     "smoke:guard": "npm run -s build && node scripts/guard-smoke.mjs",
     "smoke:routing": "npm run -s build && node scripts/routing-smoke.mjs",
     "smoke:capacity": "npm run -s build && node scripts/capacity-smoke.mjs",
-    "smoke:memory": "npm run -s build && node scripts/memory-smoke.mjs"
+    "smoke:memory": "npm run -s build && node scripts/memory-smoke.mjs",
+    "smoke:providers": "npm run -s build && node scripts/providers-smoke.mjs"
   },
   "license": "ISC",
   "type": "commonjs",
````

### Step 3 — Fix your Ollama address (one line in `routes.json`)

In `routes.json` there is exactly one line `"baseURL": "https://ollama.com/api"` (inside the `"ollama"` provider). Change it to `"baseURL": "https://ollama.com"` and change nothing else. Either edit that one line by hand, or run this from the repo root (macOS and Linux; it makes a backup `routes.json.bak`):

```bash
sed -i.bak 's#"baseURL": "https://ollama.com/api"#"baseURL": "https://ollama.com"#' routes.json
```

Check with: `grep -n "ollama.com" routes.json` (expect one line ending `https://ollama.com",`). The router reloads `routes.json` by itself. You can also do it in the UI after prompt 14: Providers > ollama > Edit > Base URL.

## Verify

```bash
npx tsc --noEmit                    # no output
npm run build                       # built
node scripts/smoke.mjs && node scripts/admin-smoke.mjs && node scripts/guard-smoke.mjs && node scripts/routing-smoke.mjs && node scripts/capacity-smoke.mjs && node scripts/memory-smoke.mjs && node scripts/providers-smoke.mjs   # ALL PASSED x7
```
`providers-smoke.mjs` has 47 checks through the real router with a mock OpenAI-style server and a mock Claude-style server: a plain request is converted and answered in Claude's format with usage split; Claude-only fields are not sent; Bearer-only auth; tool calls come back as `tool_use` with parsed input and tool results go out in the right order; streaming has the same event order as Claude's API, tool arguments join to valid JSON, blocks close before the next opens; a free OpenAI-style provider that runs out of balance fails over to a Claude-style provider and the trace says why; the connection test works on both formats; the four address mistakes and an unknown protocol are refused with reasons (including `https://ollama.com/api`); the catalog lists 14 entries with the correct Ollama address; adding from the catalog creates provider, key, models and prices in one save, never echoes the secret, reuses a provider, picks fresh aliases, applies a free-tier daily limit, refuses a name taken by another address, refuses a key for a keyless provider and leaves nothing behind when it fails; a free OpenAI-style model writes a router-memory summary.
