/**
 * "Where do my prompt tokens go?" Splits the prompt Claude Code sent into the parts that make it up.
 * Numbers are estimates (about 3.5 characters per token); images count as a fixed cost.
 */
export interface Anatomy {
  system: number;
  tools: number;
  userText: number;
  assistantText: number;
  thinking: number;
  toolUse: number;
  toolResult: number;
  images: number;
  total: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const CPT = 3.5;
const IMAGE_TOKENS = 1700;

const len = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try { return JSON.stringify(v).length; } catch { return 0; }
};

function textLen(c: Json): { chars: number; images: number } {
  if (typeof c === "string") return { chars: c.length, images: 0 };
  let chars = 0, images = 0;
  if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === "text") chars += String(p.text ?? "").length;
      else if (p?.type === "image") images++;
      else chars += len(p);
    }
  }
  return { chars, images };
}

export function promptAnatomy(body: Json): Anatomy {
  const a = { system: 0, tools: 0, userText: 0, assistantText: 0, thinking: 0, toolUse: 0, toolResult: 0, images: 0 };
  try {
    a.system = len(body?.system) / CPT;
    a.tools = len(body?.tools) / CPT;
    const msgs: Json[] = Array.isArray(body?.messages) ? body.messages : [];
    let imgs = 0;
    for (const m of msgs) {
      const blocks: Json[] = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];
      for (const b of blocks) {
        switch (b?.type) {
          case "text": (m.role === "assistant" ? (a.assistantText += String(b.text ?? "").length / CPT) : (a.userText += String(b.text ?? "").length / CPT)); break;
          case "thinking": case "redacted_thinking": a.thinking += len(b.thinking ?? b.data) / CPT; break;
          case "tool_use": a.toolUse += len(b.input) / CPT + 12; break;
          case "tool_result": { const t = textLen(b.content); a.toolResult += t.chars / CPT; imgs += t.images; break; }
          case "image": imgs++; break;
          default: a.userText += len(b) / CPT;
        }
      }
    }
    a.images = imgs * IMAGE_TOKENS;
  } catch { /* estimates only */ }
  const r = (n: number) => Math.round(n);
  const out = {
    system: r(a.system), tools: r(a.tools), userText: r(a.userText), assistantText: r(a.assistantText),
    thinking: r(a.thinking), toolUse: r(a.toolUse), toolResult: r(a.toolResult), images: r(a.images),
  };
  return { ...out, total: Object.values(out).reduce((x, y) => x + y, 0) };
}