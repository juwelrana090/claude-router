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
