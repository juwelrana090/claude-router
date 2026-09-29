# Memory System Index
> ⚠️ PROJECT SCOPED: All memory lives in .claude/ only.

## Directory Structure
.claude/
├── skills/              → LOCAL CACHE (read first every session)
│   ├── _base.md         → condensed rules + patterns + gotchas
│   ├── _stack.md        → stack-specific guidance
│   └── _modules-index.md → lightweight module name→file map
├── memory/              → source of truth memory files
├── modules/             → per module memory files
├── tasks/
│   ├── todo/            → tasks waiting to be picked up
│   ├── inprogress/      → tasks being worked on
│   ├── done/            → completed tasks
│   ├── plans/           → feature plans before coding
│   ├── logs/            → completed task logs
│   └── eod/             → personal EOD (gitignored)
└── commands/
    ├── system/          → built-in r- commands
    └── custom/          → your custom r- commands

## Cache-First Quick Reference
| Situation | Command | Cache used |
|---|---|---|
| Start session | /r-start | _base + _stack + _modules-index |
| Execute a task | /r-task [desc] | _base + _stack |
| Find/impact anything | /r-find [thing] | _modules-index |
| Fix a bug | /r-fix [desc] | _base (gotchas) |
| Plan a feature | /r-plan [feature] | _base + _stack |
| List/add/pick tasks | /r-todo | (no cache needed) |
| Mark done + review | /r-done | _base |
| Log knowledge | /r-log decision/gotcha/pattern | (writes to memory) |
| Memory maintenance | /r-memory scan/update/status | (reads/writes memory) |
| Refresh cache | /r-cache warm | rewrites all skills/ |
| End session | /r-end | (no cache needed) |

## Core Memory Files
| File | Purpose |
|---|---|
| CLAUDE.md | Auto-loaded every session |
| skills/_base.md | Fast-load: rules, patterns, gotchas condensed |
| skills/_stack.md | Fast-load: stack-specific guidance |
| skills/_modules-index.md | Fast-load: module name→file map |
| memory/context.md | Product purpose and priorities |
| memory/architecture.md | System design and data flow |
| memory/rules.md | Non-negotiable coding rules |
| memory/patterns.md | Established code patterns |
| memory/decisions.md | Architecture decision log |
| memory/gotchas.md | Known traps and footguns |
| memory/dependencies.md | Module dependency map |
| memory/pre-task-checklist.md | Run before every task |
| memory/post-task-checklist.md | Run after every task |
