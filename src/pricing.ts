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
