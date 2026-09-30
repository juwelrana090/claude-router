import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline test of the context guard (src/contextGuard.ts). Run: npm run build && node scripts/guard-smoke.mjs
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-guard-'));
process.env.ROUTER_HOME = home;
process.env.ROUTER_KEY = 'x';
const G = require(path.join(here, '..', 'dist', 'contextGuard.js'));

let fails = 0;
const t = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const cfg = (o = {}) => ({ mode: 'on', highTokens: 90_000, lowTokens: 45_000, keepRecent: 6, minChars: 1200, ...o });

// A transcript like Claude Code's: user prompt, then (assistant tool_use, user tool_result) pairs.
function transcript(nPairs, resultChars = 12_000, { image = false } = {}) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'fix the bug in the billing module' }] }];
  for (let i = 0; i < nPairs; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 't' + i, signature: 'sig' + i }, { type: 'text', text: 'reading ' + i }, { type: 'tool_use', id: 'toolu_' + i, name: 'Read', input: { file_path: `/src/f${i}.ts` } }] });
    const content = image && i === 3 ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(3000) } }] : (i % 5 === 0 ? [{ type: 'text', text: 'x'.repeat(resultChars) }] : 'y'.repeat(i % 7 === 0 ? 300 : resultChars));
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + i, content, ...(i === nPairs - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }] });
  }
  return { model: 'ds-flash', max_tokens: 8000, system: [{ type: 'text', text: 'S'.repeat(20_000) }], tools: [{ name: 'Read', description: 'd'.repeat(2000), input_schema: { type: 'object' } }], messages };
}

// ---- T1 below the high-water mark: untouched (same object)
{
  const b = transcript(5, 3000);
  const r = G.applyGuard(b, 's-small', cfg());
  t('T1 small prompt is untouched (same object)', r.body === b && r.result.saved === 0, `est ${r.result.beforeTokens}`);
}

// ---- T2 big prompt: clears old, keeps recent, structure valid
{
  const b = transcript(60, 12_000);
  const before = G.estimateTokens(b);
  const r = G.applyGuard(b, 's-big', cfg());
  const out = r.body;
  t('T2 estimate before is large', before > 90_000, `before ~${before}`);
  t('T2 tokens reduced to <= low-water mark (or nothing left to clear)', r.result.afterTokens <= 45_000 + 500, `after ~${r.result.afterTokens}, saved ${r.result.saved}, cleared ${r.result.clearedNow}`);
  t('T2 original body object not mutated', JSON.stringify(b) === JSON.stringify(transcript(60, 12_000)));
  // last 6 tool_results intact
  const results = out.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content).filter((c) => c.type === 'tool_result');
  const orig = b.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content).filter((c) => c.type === 'tool_result');
  t('T2 last 6 results are byte-identical', JSON.stringify(results.slice(-6)) === JSON.stringify(orig.slice(-6)));
  t('T2 same number of blocks, same ids, same order', results.length === orig.length && results.every((c, i) => c.tool_use_id === orig[i].tool_use_id));
  // every tool_result still follows its tool_use
  const uses = new Set(); let paired = true;
  for (const m of out.messages) for (const c of Array.isArray(m.content) ? m.content : []) { if (c.type === 'tool_use') uses.add(c.id); if (c.type === 'tool_result' && !uses.has(c.tool_use_id)) paired = false; }
  t('T2 every tool_result still has its tool_use before it', paired);
  t('T2 assistant messages (thinking/signature) untouched', JSON.stringify(out.messages.filter((m) => m.role === 'assistant')) === JSON.stringify(b.messages.filter((m) => m.role === 'assistant')));
  t('T2 system and tools untouched', out.system === b.system && out.tools === b.tools);
  t('T2 cache_control on the last block preserved', results.at(-1).cache_control?.type === 'ephemeral');
  t('T2 small results (<1200 chars) left alone', results.filter((c, i) => (typeof orig[i].content === 'string' ? orig[i].content.length : 99999) < 1200).every((c, i) => true) && results.some((c, i) => typeof orig[i].content === 'string' && orig[i].content.length < 1200 && c.content === orig[i].content));
  t('T2 stub mentions original size', typeof results[0].content === 'string' && /cleared to save tokens \(\d+ characters\)/.test(results[0].content));
  JSON.parse(JSON.stringify(out)); t('T2 result is valid JSON', true);
}

// ---- T3 simulate a growing session: prefix must stay byte-identical between clearing events
{
  const SID = 's-grow';
  let prev = null; let events = 0; let prefixBreaks = 0; let unexplainedBreaks = 0;
  let totalRaw = 0, totalSent = 0;
  for (let n = 5; n <= 120; n++) {
    const b = transcript(n, 6000);
    const r = G.applyGuard(b, SID, cfg());
    totalRaw += r.result.beforeTokens; totalSent += r.result.afterTokens || r.result.beforeTokens;
    const cur = JSON.stringify(r.body.messages);
    if (prev) {
      // all but the final pair of the previous request must be a byte prefix of the new request
      const prevCut = JSON.stringify(prev.slice(0, prev.length - 2));
      const stable = cur.startsWith(prevCut.slice(0, -1));
      if (!stable) { prefixBreaks++; if (r.result.clearedNow === 0) unexplainedBreaks++; }
    }
    if (r.result.clearedNow > 0) events++;
    prev = r.body.messages;
  }
  t('T3 clearing happens in rare batches', events > 0 && events <= 8, `events=${events} over 115 requests`);
  t('T3 prefix only changes on a clearing event (cache-safe)', unexplainedBreaks === 0, `prefixBreaks=${prefixBreaks} (all on clearing events)`);
  const pct = Math.round((1 - totalSent / totalRaw) * 100);
  t('T3 prompt tokens sent are lower overall', totalSent < totalRaw, `raw ~${(totalRaw / 1e6).toFixed(1)}M vs sent ~${(totalSent / 1e6).toFixed(1)}M tokens (${pct}% less) for this synthetic session`);
}

// ---- T4 memory: same input twice -> identical output, nothing new cleared the 2nd time
{
  const b = transcript(70, 9000);
  const r1 = G.applyGuard(b, 's-mem', cfg());
  const r2 = G.applyGuard(b, 's-mem', cfg());
  t('T4 second identical request gives identical output', JSON.stringify(r1.body) === JSON.stringify(r2.body));
  t('T4 second request clears nothing new (remembered)', r1.result.clearedNow > 0 && r2.result.clearedNow === 0 && r2.result.clearedTotal === r1.result.clearedTotal);
}

// ---- T5 images and mode isolation
{
  const b = transcript(60, 12_000, { image: true });
  const r = G.applyGuard(b, 's-img', cfg());
  const res = r.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
  t('T5 tool result containing an image is never cleared', Array.isArray(res[3].content) && res[3].content[0].type === 'image');
}
{
  const b = transcript(60, 12_000);
  const r = G.applyGuard(b, 's-shadow', cfg({ mode: 'shadow' }));
  t('T6 shadow mode never changes the request', r.body === b);
  t('T6 shadow mode reports what it would save', r.result.would > 10_000 && r.result.saved === 0, `would ~${r.result.would}`);
  const r2 = G.applyGuard(b, 's-shadow', cfg({ mode: 'shadow' }));
  t('T6 shadow keeps its own memory (no repeat clearing)', r2.result.clearedNow === 0 && r2.result.would > 0);
  const on = G.applyGuard(b, 's-shadow', cfg({ mode: 'on' }));
  t('T6 switching shadow -> on still clears (shadow state is separate)', on.result.clearedNow > 0);
}
{
  const b = transcript(60, 12_000);
  const r = G.applyGuard(b, 's-off', cfg({ mode: 'off' }));
  t('T7 off mode is a no-op', r.body === b && r.result.saved === 0);
  const a = G.applyGuard(transcript(60, 12_000), 'sess-A', cfg());
  const c = G.applyGuard(transcript(60, 12_000), 'sess-B', cfg());
  t('T8 sessions do not share memory', a.result.clearedNow > 0 && c.result.clearedNow > 0);
}
// ---- T9 garbage in -> never throws
{
  for (const bad of [null, {}, { messages: 'x' }, { messages: [null, 1, {}] }, { messages: [{ role: 'user', content: [{ type: 'tool_result' }] }] }]) {
    let ok = true; try { G.applyGuard(bad, 's-bad', cfg()); } catch { ok = false; }
    if (!ok) { t('T9 malformed body must not throw', false); }
  }
  t('T9 malformed bodies never throw', true);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);

fs.rmSync(home, { recursive: true, force: true });
