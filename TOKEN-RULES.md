# Token rules (reference)

> On-demand reference. **Not** auto-loaded — it costs nothing per request. Read it when you
> audit token spend or tune a prompt. The always-loaded rules live in `CLAUDE.md`.
>
> If you want a rule enforced on every request, put it in `CLAUDE.md` (budget: 400 tokens).

## Measure first

```bash
node scripts/token-meter.mjs 24h     # or 1h / 7d / all
```

`logs/usage.jsonl` is written by the router on every real `/v1/messages` request. If the
meter says the log is missing, Claude Code is **not** pointed at the router, so nothing is
being recorded. Do not fabricate a baseline; fix the pointer, use the tool, then measure.

Never print or commit `.env` / key values. The meter reads only the usage log.

## Reading the numbers

| Signal | Healthy | What it usually means |
|---|---|---|
| cache hit rate | > 60% | below that the system prompt churns between requests |
| output / all tokens | < 30% | above that a chatty habit, not a hard task |
| errors per 1000 req | < 10 | above that cooldowns/failover are burning retries |
| per-80k-request | — | re-measure; a jump means the prompt or config changed |

**Aggregate before optimizing.** A 10% saving on a small bucket is noise. Fix the largest
bucket first, then re-measure and confirm the ratio moved.

## The 80% rule

- A request should use **< 80% of the model's real context window**.
- Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to the model's **real** context size, not a guess.
  If it is larger than reality, auto-compact never fires, the request grows until the
  upstream rejects it, and **every token in that request is wasted**.
- `/compact` at the end of a long task, `/clear` between unrelated tasks. Both are cheaper
  than re-sending a bloated transcript.
- Never work in `dist/`, `node_modules/`, or `logs/`. The deny list in
  `.claude/settings.json` enforces this; do not route around it.

## Why the system prompt repeats

Claude Code re-sends the system prompt on every request. Anything always-loaded is paid for
on every request, forever:

| Always on the wire | Measured here |
|---|---|
| `CLAUDE.md` | 426 tok |
| plugin **skill descriptions** | ~9,900 tok (105 skills / 23 plugins) |
| plugin **command descriptions** | ~666 tok (33 commands) |

Plugins contribute ~25x more than `CLAUDE.md`. Skills with long `description:` frontmatter
are the worst offenders because the description ships whether or not the skill is used.

## Model tiering

Map aliases to models that match the task:

- cheap/fast model for reads, greps, boilerplate, formatting
- strong model only for architecture, tricky debugging, security and final review
- `haiku` for titles, summaries and classification

If every alias points at the same model, tiering buys nothing: you pay strong-model prices
for trivial work and still get one failure domain. Routing it through this repo's
`defaultModel` + `opus`/`sonnet`/`haiku` aliases is what makes the split real — and the
usage log is what proves it worked.

## Rules for changing prompts

1. Measure. Record the number and the command.
2. Make the smallest change.
3. Re-measure with the **same** range.
4. If it did not improve, revert and say so.

Do not add rules "just in case". Every line in `CLAUDE.md` and every skill description is a
recurring bill.
