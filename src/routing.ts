import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config, ModelCfg, ProviderCfg } from "./config";

export function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(",") : v;
}

export function resolveAlias(c: Config, raw: string): string | undefined {
  const name = raw.replace(/\[[^\]]*\]$/, "").trim(); // "sonnet[1m]" -> "sonnet"
  if (c.models[name]) return name;
  const lower = name.toLowerCase();
  for (const [needle, target] of Object.entries(c.aliases ?? {})) {
    if (lower.includes(needle) && c.models[target]) return target;
  }
  if (c.defaultModel && c.models[c.defaultModel]) {
    console.warn(`[ROUTER] unknown model "${raw}" -> default "${c.defaultModel}"`);
    return c.defaultModel;
  }
  return undefined;
}

// Sticky key choice keeps the provider-side prompt cache warm (cache is per account/key).
export function keyOrder(p: ProviderCfg, m: ModelCfg, seed: string): string[] {
  if (m.key) return process.env[m.key] ? [m.key] : [];
  const names = p.keys.filter((k) => process.env[k]);
  if (!names.length) return [];
  const start = crypto.createHash("sha1").update(seed).digest().readUInt32BE(0) % names.length;
  return names.map((_, i) => names[(start + i) % names.length]);
}

export function buildHeaders(
  req: IncomingMessage,
  p: ProviderCfg,
  keyName: string
): Record<string, string> {
  const key = process.env[keyName] as string;
  const h: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": headerValue(req.headers["anthropic-version"]) || "2023-06-01",
  };
  if (p.auth === "bearer" || p.auth === "both") h["authorization"] = `Bearer ${key}`;
  if (p.auth === "x-api-key" || p.auth === "both") h["x-api-key"] = key;
  const beta = headerValue(req.headers["anthropic-beta"]);
  if (beta && !p.dropBeta) h["anthropic-beta"] = beta;
  return h;
}

export function buildBody(
  body: Record<string, unknown>,
  m: ModelCfg,
  p: ProviderCfg
): string {
  const out: Record<string, unknown> = { ...body, model: m.model };
  for (const f of p.dropBodyFields ?? []) delete out[f];
  if (m.maxOutputTokens && typeof out.max_tokens === "number" && out.max_tokens > m.maxOutputTokens) {
    out.max_tokens = m.maxOutputTokens; // clamp DOWN only
  }
  return JSON.stringify(out);
}
