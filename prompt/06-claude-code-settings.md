# 06 — Claude Code settings: keep sessions small at the source (no repo code)

**Independent of 01–05.** This edits your Claude Code user settings, not this repo. Do this step yourself or paste it to your local AI; it touches only the one file named below.

## Step 1 — Compact earlier

Open `%USERPROFILE%\.claude\settings.json` (on Windows this is `C:\Users\<you>\.claude\settings.json`). Inside the existing `"env": { ... }` object add these two lines (keep every other line; mind the commas):

```json
"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "120000",
"CLAUDE_CODE_DISABLE_1M_CONTEXT": "1"
```

- Plain integers only: `120000`, never `120k`. As an environment variable `120k` would be read as 120 and clamped to the 100K minimum, which makes it compact constantly.
- Why: without this Claude Code assumes a big window for your router aliases and only compacts near the top. Your log shows prompts growing to 168K before shrinking, 10 times in one session.
- Some Claude Code versions have been reported to ignore some values from `settings.json`. If, after a restart, the **Context size** card on the router's Live page still shows prompts far above ~130K, set both as Windows user environment variables instead (`setx CLAUDE_CODE_AUTO_COMPACT_WINDOW 120000`, `setx CLAUDE_CODE_DISABLE_1M_CONTEXT 1`), then fully close and reopen VS Code.
- Inside Claude Code you can also run `/autocompact 120k` once (needs v2.1.221+; you have 2.1.284).

## Step 2 — Habits that make the biggest difference

| Situation | Do this | Why |
|---|---|---|
| Starting an unrelated task | `/clear` | A new conversation starts at a few thousand tokens instead of 100K |
| Finished a big task, same topic continues | `/compact focus on <what matters>` | Summarises once; compacting a huge context is itself one big request, so do it before it grows |
| End of the day | your existing `/r-end` (saves to `.claude/tasks/eod/`) | Progress lives in a file, not in the conversation |
| Next morning | `/clear`, then your existing `/r-start` | Loads the project memory files instead of yesterday's whole chat |
| "Autocompact is thrashing" error | Read big files in chunks (`head`/line ranges), or `/compact` with a focus that drops the big output, or use a sub-agent for the big read | A huge tool output refilled the window within a few turns; the context guard (05) also clears such outputs |

Note: `/r-start` reads about 15 files (skills, memory, tasks). Keep those memory files short; everything it loads is paid for again on every later request of that session.

## Step 3 — Confirm it worked (do not skip)

Use Claude Code normally for one long task, then open the router: **Live > Context size** and **Usage > Prompt size**. Typical (p50) and Large (p90) prompt sizes should be clearly lower than your earlier 106K / 156K. If they are not, tell me the numbers; do not assume it worked.
