#!/bin/bash

# ═══════════════════════════════════════════════════════
# Claude AI Development System Setup
# Usage: ./setup-claude.sh
# ═══════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ───────────────────────────────────────────────────────
# HELPERS
# ───────────────────────────────────────────────────────

print_step() { echo -e "\n${BLUE}═══ $1 ═══${NC}"; }
print_ok()   { echo -e "${GREEN}✅ $1${NC}"; }
print_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info() { echo -e "${CYAN}ℹ️  $1${NC}"; }

make_file() {
  mkdir -p "$(dirname "$1")"
  if [ -f "$1" ]; then
    print_warn "Skipped (already exists): $1"
    cat > /dev/null  # consume stdin so heredoc doesn't hang
  else
    cat > "$1"
    print_ok "Created: $1"
  fi
}

# ───────────────────────────────────────────────────────
# SAFETY CHECK
# ───────────────────────────────────────────────────────

print_step "Safety Check"

SAFE_MODE=false
if [ -f "CLAUDE.md" ] || [ -d ".claude" ]; then
  echo ""
  print_warn "Existing Claude setup detected!"
  print_info "Running in SAFE MODE — existing files will NOT be touched"
  print_info "Only missing files and folders will be created"
  echo ""
  SAFE_MODE=true
else
  print_info "Fresh project — creating full setup"
fi

# ───────────────────────────────────────────────────────
# DETECT PROJECT
# ───────────────────────────────────────────────────────

print_step "Detecting Project"

PROJECT_NAME=$(basename "$PWD")
TODAY=$(date +%Y-%m-%d)

# Detect stack
STACK=""
[ -f "package.json" ]      && STACK="$STACK Node.js"
[ -f "composer.json" ]     && STACK="$STACK PHP/Laravel"
[ -f "requirements.txt" ]  && STACK="$STACK Python"
[ -f "Gemfile" ]           && STACK="$STACK Ruby"
[ -f "go.mod" ]            && STACK="$STACK Go"
[ -f "Cargo.toml" ]        && STACK="$STACK Rust"
[ -z "$STACK" ]            && STACK="Unknown"

# Detect source folders
SRC_FOLDERS=""
for folder in src app lib resources pages components api; do
  [ -d "$folder" ] && SRC_FOLDERS="$SRC_FOLDERS $folder/"
done

print_info "Project: $PROJECT_NAME"
print_info "Stack:   $STACK"
print_info "Source:  $SRC_FOLDERS"

# ───────────────────────────────────────────────────────
# STEP 1: CREATE FOLDER STRUCTURE
# ───────────────────────────────────────────────────────

print_step "Creating Folder Structure"

mkdir -p .claude/memory
mkdir -p .claude/modules
mkdir -p .claude/skills
mkdir -p .claude/tasks/todo
mkdir -p .claude/tasks/inprogress
mkdir -p .claude/tasks/done
mkdir -p .claude/tasks/plans
mkdir -p .claude/tasks/logs
mkdir -p .claude/tasks/eod
mkdir -p .claude/commands/system
mkdir -p .claude/commands/custom

touch .claude/tasks/eod/.gitkeep

print_ok "Folder structure created"

# ───────────────────────────────────────────────────────
# STEP 2: settings.json
# ───────────────────────────────────────────────────────

print_step "Creating Settings Files"

# Build allow paths from detected source folders
ALLOW_PATHS='"Read(.claude/**)",
      "Read(.claude/skills/**)",
      "Read(CLAUDE.md)"'

for folder in $SRC_FOLDERS; do
  folder=$(echo "$folder" | xargs)
  ALLOW_PATHS="$ALLOW_PATHS,
      \"Read($folder**)\",
      \"Write($folder**)\""
done

ALLOW_PATHS="$ALLOW_PATHS,
      \"Write(.claude/tasks/**)\",
      \"Write(.claude/memory/**)\",
      \"Write(.claude/modules/**)\",
      \"Write(.claude/skills/**)\",
      \"Write(.claude/commands/**)\""

make_file ".claude/settings.json" << EOF
{
  "permissions": {
    "allow": [
      $ALLOW_PATHS
    ],
    "deny": [
      "Write(~/**)",
      "Write(../**)",
      "Read(~/.ssh/**)",
      "Read(~/.env/**)"
    ]
  }
}
EOF

make_file ".claude/settings.local.json" << 'EOF'
{
  "developerName": "",
  "notes": "Fill in your name above. This file is yours only — never commit it."
}
EOF

# ───────────────────────────────────────────────────────
# STEP 3: CLAUDE.md
# ───────────────────────────────────────────────────────

print_step "Creating CLAUDE.md"

make_file "CLAUDE.md" << EOF
# CLAUDE.md — Project Memory

> ⚠️ PROJECT SCOPED: Everything lives in .claude/ only.
> Never read or write outside this project root.
> Auto-loaded by Claude Code every session.

## 🚀 Local Cache First — Non Negotiable

Before ANY reasoning, inference, or API call, ALWAYS load local files in this order:

1. .claude/skills/_base.md          ← rules + patterns summary (fast reload)
2. .claude/skills/_stack.md         ← stack-specific cached guidance
3. .claude/memory/context.md        ← product context
4. .claude/memory/rules.md          ← non-negotiable rules
5. .claude/memory/gotchas.md        ← known traps
6. .claude/skills/_modules-index.md ← lightweight module map (touch modules/ only if needed)

WHY: These files are your local cache. Reading them first means zero wasted API
tokens re-discovering facts already stored. Only read deeper files when the task
requires it. Never ask the user for information already in local cache.

Cache hit = read .claude/skills/ → use directly.
Cache miss = read .claude/memory/ + .claude/modules/ → then update .claude/skills/.

## 🔒 Scope Rules — Non Negotiable
- ALL memory files → .claude/memory/
- ALL module files → .claude/modules/
- ALL task logs → .claude/tasks/logs/
- ALL plans → .claude/tasks/plans/
- ALL todo tasks → .claude/tasks/todo/
- ALL inprogress tasks → .claude/tasks/inprogress/
- ALL done tasks → .claude/tasks/done/
- ALL EOD summaries → .claude/tasks/eod/
- ALL commands → .claude/commands/
- NEVER write any file outside project root
- NEVER read memory from global or external paths
- NEVER create .md files at project root except CLAUDE.md
- If a path does not start with .claude/ — stop and fix it

## 🧭 Project Context
- **Name**: $PROJECT_NAME
- **Purpose**: [to be filled after Claude scans project]
- **Stack**: $STACK
- **Current Phase**: [MVP / Growth / Maintenance]
- **Target Users**: [to be filled]
- **Critical Paths**: [to be filled]
- **Current Priorities**: [to be filled]

## 📁 Project Structure
[Run /r-memory-scan to auto-fill this section]

## 🏗️ Architecture
- **Layers**: [to be filled]
- **Data Flow**: [to be filled]
- **Auth**: [to be filled]
- **External Services**: [to be filled]
- **Environment Differences**: [to be filled]

## 📏 Non-Negotiable Rules
[Run /r-memory-scan to auto-fill based on existing code]

✅ DO: [to be filled]
❌ DON'T: [to be filled]

## 🔁 Established Patterns
[Run /r-memory-scan to auto-fill]

## ⚠️ Gotchas
[Run /r-memory-scan to auto-fill]

## 🧩 Module Map
[Run /r-memory-scan to auto-fill]

## 🔗 Dependency Map
[Run /r-memory-scan to auto-fill]

## 📌 Key Decisions
[Run /r-memory-scan to auto-fill]

## 🛠️ Dev Commands
- Install:
- Dev server:
- Build:
- Test:
- Lint:
- Migrate:
- Seed:
- Deploy:

## ⚙️ Settings
- .claude/settings.json → shared team settings — always commit
- .claude/settings.local.json → personal settings — never commit
- First thing after cloning: add your name to settings.local.json

## 👥 Team Guidelines
- All .claude/ files are shared — commit all changes
- Only settings.local.json and tasks/eod/ are personal/gitignored
- Every developer can work on all modules
- When you update any memory file — commit so team benefits
- After touching a module — update .claude/modules/[name].md
- New gotcha found — add to .claude/memory/gotchas.md and commit
- New pattern found — add to .claude/memory/patterns.md and commit
- Architecture decision made — add to .claude/memory/decisions.md and commit
- Run /r-memory-scan after pulling major changes

## 📋 Task Collaboration
- See all tasks: /r-todo
- Add task for team: /r-add-task [description]
- Pick up a task: /r-pickup
- Mark task done: /r-done
- All tasks are shared — commit and push after adding

## 📋 Before Every Task
1. Re-read this file
2. Read .claude/modules/[relevant].md
3. Read .claude/memory/gotchas.md
4. Read .claude/memory/dependencies.md
5. State plan before writing any code
6. List all files that will change
7. Check blast radius
8. Confirm plan follows all rules above

## 📋 After Every Task
1. Update .claude/modules/[affected].md
2. Append to module changelog
3. Log new gotchas to .claude/memory/gotchas.md
4. Log new patterns to .claude/memory/patterns.md
5. Log new decisions to .claude/memory/decisions.md
6. Update architecture.md if structure changed
7. Update this CLAUDE.md if anything major changed
8. Save task log to .claude/tasks/logs/$TODAY-[title].md
9. Set memory confidence flags on updated modules
EOF

# ───────────────────────────────────────────────────────
# STEP 4: MEMORY FILES
# ───────────────────────────────────────────────────────

print_step "Creating Memory Files"

make_file ".claude/memory/context.md" << EOF
# Project Context
> ⚠️ PROJECT SCOPED: This file lives in .claude/memory/ only.
> Run /r-memory-scan to auto-fill from codebase.

- **Product Name**: $PROJECT_NAME
- **Purpose**: [to be filled]
- **Target Users**: [to be filled]
- **Current Phase**: [to be filled]
- **What Success Looks Like**: [to be filled]
- **What Must Never Break**: [to be filled]
- **Known Technical Debt**: [to be filled]
EOF

make_file ".claude/memory/architecture.md" << 'EOF'
# Architecture
> ⚠️ PROJECT SCOPED: This file lives in .claude/memory/ only.
> Run /r-memory-scan to auto-fill from codebase.

## Stack
[to be filled]

## Folder Structure
[to be filled]

## System Layers
[to be filled]

## Data Flow
[to be filled]

## Auth Flow
[to be filled]

## External Services
[to be filled]

## Environment Differences
[to be filled]

## Key Design Decisions
[to be filled]
EOF

make_file ".claude/memory/rules.md" << 'EOF'
# Rules — Non Negotiable
> ⚠️ PROJECT SCOPED: This file lives in .claude/memory/ only.
> Run /r-memory-scan to auto-fill from codebase.

## Naming Conventions
✅ DO: [to be filled]
❌ DON'T: [to be filled]

## Import Rules
✅ DO: [to be filled]
❌ DON'T: [to be filled]

## Function Rules
✅ DO: [to be filled]
❌ DON'T: [to be filled]

## Error Handling
✅ DO: [to be filled]
❌ DON'T: [to be filled]

## Testing Rules
✅ DO: [to be filled]
❌ DON'T: [to be filled]

## Forbidden Patterns
❌ NEVER: [to be filled]

## Environment Variables
✅ DO: [to be filled]
❌ DON'T: [to be filled]
EOF

make_file ".claude/memory/patterns.md" << 'EOF'
# Established Patterns
> ⚠️ PROJECT SCOPED: This file lives in .claude/memory/ only.
> Run /r-memory-scan to auto-fill from codebase.

[Patterns will be added here as they are discovered]

## Template
#### [Pattern Name]
- **When to use**:
- **Example**: [file path + snippet]
- **Anti-pattern**:
EOF

make_file ".claude/memory/decisions.md" << EOF
# Architecture Decisions
> ⚠️ PROJECT SCOPED: This file lives in .claude/memory/ only.

[Decisions will be logged here as they are made]

## Template
#### [date] — [Title]
- **Problem**:
- **Options Considered**:
- **Decision**:
- **Reason**:
- **Tradeoffs**:
- **Revisit If**:

---

#### $TODAY — Initial Setup
- **Problem**: Need a structured AI-assisted development system
- **Decision**: Claude Code with .claude/ memory system
- **Reason**: Project-scoped, team-shared, native Claude Code support
- **Tradeoffs**: Requires Claude Code installation
- **Revisit If**: Team grows beyond 10 developers
EOF

make_file ".claude/memory/gotchas.md" << 'EOF'
# Gotchas
> ⚠️ PROJECT SCOPED: This file lives in .claude/memory/ only.
> Run /r-memory-scan to auto-fill from codebase.

[Gotchas will be added here as they are discovered]

## Template
#### [Module] — [Title]
- **What Happens**:
- **Why**:
- **How to Avoid**:
- **Discovered**:
EOF

make_file ".claude/memory/dependencies.md" << 'EOF'
# Module Dependencies
> ⚠️ PROJECT SCOPED: This file lives in .claude/memory/ only.
> Run /r-memory-scan to auto-fill from codebase.

## Module Dependency Map
[to be filled]

## Shared Utilities
[files used across 3+ modules]

## High Risk Modules
[most depended on — highest blast radius]

## External Package Usage
[which packages used where and why]

## Circular Dependencies
[any detected circular imports]
EOF

make_file ".claude/memory/pre-task-checklist.md" << 'EOF'
# Pre Task Checklist
> ⚠️ Run every item before starting any task.

- [ ] Re-read CLAUDE.md
- [ ] Read .claude/modules/[relevant].md
- [ ] Read .claude/memory/gotchas.md for this area
- [ ] Read .claude/memory/dependencies.md
- [ ] State complete plan before writing any code
- [ ] List all files that will change
- [ ] Check blast radius
- [ ] Confirm plan follows .claude/memory/rules.md
- [ ] Confirm plan uses patterns from .claude/memory/patterns.md
EOF

make_file ".claude/memory/post-task-checklist.md" << 'EOF'
# Post Task Checklist
> ⚠️ Complete every item after finishing any task.

- [ ] All rules from .claude/memory/rules.md followed
- [ ] Existing patterns used correctly
- [ ] Errors handled correctly
- [ ] .claude/modules/[affected].md updated
- [ ] Changelog appended in module file
- [ ] New gotchas logged to .claude/memory/gotchas.md
- [ ] New patterns logged to .claude/memory/patterns.md
- [ ] New decisions logged to .claude/memory/decisions.md
- [ ] CLAUDE.md updated if needed
- [ ] Task log saved to .claude/tasks/logs/YYYY-MM-DD-[title].md
- [ ] Memory confidence flags set on updated modules
- [ ] .claude/skills/_modules-index.md updated if modules changed
- [ ] .claude/skills/_base.md updated if new rules/patterns/gotchas added
- [ ] If many changes: run /r-cache-warm to fully rebuild skill cache
EOF

make_file ".claude/memory/INDEX.md" << 'EOF'
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
EOF

make_file ".claude/memory/VERSION" << EOF
Memory System Version: 1.0.0
Created: $TODAY
Project: $PROJECT_NAME
Memory Root: .claude/memory/
Modules Root: .claude/modules/
Skills Root: .claude/skills/
Tasks Root: .claude/tasks/
Commands Root: .claude/commands/
Last Full Scan: pending — run /r-memory-scan
Last Cache Warm: pending — run /r-cache-warm
Generated By: setup-claude.sh
EOF

# ───────────────────────────────────────────────────────
# STEP 4.5: LOCAL SKILL CACHE FILES
# ───────────────────────────────────────────────────────

print_step "Creating Local Skill Cache"

make_file ".claude/skills/README.md" << 'EOF'
# Local Skill Cache

This directory is the LOCAL CACHE layer.
Claude reads these files FIRST before touching memory/ or modules/.

## How it works
- _base.md         → condensed rules + patterns (rebuilt by /r-cache-warm)
- _stack.md        → stack-specific guidance (rebuilt by /r-cache-warm)
- _modules-index.md → lightweight module name→file map (rebuilt by /r-cache-warm)
- Custom skills    → any .md file you add here is auto-loaded as a local skill

## Cache is stale when
- You run /r-memory-scan (rebuilds memory/ but not cache)
- You add a new module
- You update rules or patterns in memory/

## To refresh
Run: /r-cache-warm
This re-reads all memory/ + modules/ and rewrites the cache files.
EOF

make_file ".claude/skills/_base.md" << EOF
# Base Skill Cache — $PROJECT_NAME
# Generated: $TODAY | Refresh with /r-cache-warm

## Project
- Name: $PROJECT_NAME
- Stack: $STACK
- Root: .claude/

## Quick Rules (from memory/rules.md)
[Run /r-cache-warm to populate from memory/rules.md]

## Key Patterns (from memory/patterns.md)
[Run /r-cache-warm to populate from memory/patterns.md]

## Top Gotchas (from memory/gotchas.md)
[Run /r-cache-warm to populate from memory/gotchas.md]

## Cache Status
🔴 Cold — run /r-cache-warm to fill this file with live project data.
EOF

make_file ".claude/skills/_stack.md" << EOF
# Stack Skill Cache — $PROJECT_NAME
# Generated: $TODAY | Refresh with /r-cache-warm

## Detected Stack: $STACK
## Source Folders: $SRC_FOLDERS

## Stack-Specific Rules
[Run /r-cache-warm to populate from memory/rules.md + codebase scan]

## Dev Commands (fill these in)
- Install:
- Dev server:
- Build:
- Test:
- Lint:

## Cache Status
🔴 Cold — run /r-cache-warm to fill this file.
EOF

make_file ".claude/skills/_modules-index.md" << 'EOF'
# Module Index Cache
# Lightweight map: module name → file path → confidence
# Refresh with /r-cache-warm

| Module | File | Confidence | Last Updated |
|---|---|---|---|
[Run /r-cache-warm to auto-fill from .claude/modules/]

## Cache Status
🔴 Cold — run /r-cache-warm to scan modules/ and fill this index.
EOF

print_ok "Skill cache files created (cold — run /r-cache-warm after setup)"

# ───────────────────────────────────────────────────────
# STEP 5: TASK READMES
# ───────────────────────────────────────────────────────

print_step "Creating Task Folders"

make_file ".claude/tasks/todo/README.md" << EOF
# 📋 Todo Tasks
Anyone on the team can add tasks here.
Anyone on the team can pick up any task.

## How to add a task
Run: /r-add-task [description]
Or create: .claude/tasks/todo/$TODAY-[title].md

## Task template
---
# Task: [title]
**Added By**: [name]
**Date Added**: $TODAY
**Priority**: 🔴 High / 🟡 Medium / 🟢 Low
**Module**: [which module]
**Estimated Effort**: Small / Medium / Large
**Assigned To**: unassigned

## Description
[what needs to be done and why]

## Acceptance Criteria
- [ ] [what done looks like]

## Notes
[context, gotchas, links]

## Related Files
[relevant file paths]
---

## How to pick up a task
Run: /r-pickup
Commit and push so team knows it is taken.
EOF

make_file ".claude/tasks/inprogress/README.md" << 'EOF'
# 🔄 In Progress
Tasks currently being worked on.
Move here from todo/ when you start.
Commit so team knows who is working on what.
EOF

make_file ".claude/tasks/done/README.md" << 'EOF'
# ✅ Done
Completed tasks.
Team and Claude read these to understand project history.
EOF

make_file ".claude/tasks/plans/README.md" << 'EOF'
# 📐 Plans
Feature plans created before coding.
Always plan large features before starting.
Run: /r-plan [feature name]
EOF

make_file ".claude/tasks/logs/README.md" << 'EOF'
# 📝 Task Logs
Logs of completed tasks.
Auto-created by /r-task and /r-done commands.
EOF

# ───────────────────────────────────────────────────────
# STEP 6: SYSTEM COMMANDS
# ───────────────────────────────────────────────────────

print_step "Creating System Commands"

make_file ".claude/commands/system/r-start.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Read only from this project's .claude/ directory.

## Local Cache First — load in this order before anything else
1. .claude/skills/_base.md
2. .claude/skills/_stack.md
3. .claude/skills/_modules-index.md
If any of the above are marked 🔴 Cold, note it and continue — do not stop.

## Then load full memory
4. CLAUDE.md (already loaded by Claude Code)
5. .claude/memory/context.md
6. .claude/memory/architecture.md
7. .claude/memory/rules.md
8. .claude/memory/patterns.md
9. .claude/memory/gotchas.md
10. .claude/memory/dependencies.md
11. Last 3 files in .claude/tasks/logs/
12. Last file in .claude/tasks/eod/ if exists
13. Scan all .claude/modules/ — flag any 🔴 Stale
14. Read .claude/tasks/todo/ — count and sort by priority
15. Read .claude/tasks/inprogress/ — list what is in progress

Report:
- ✅ Memory loaded — what you know about this project
- ⚠️ Cache status — if skills/ files are cold, show: "Run /r-cache-warm to speed up future sessions"
- ⚠️ Stale modules — list with suggested action
- 🔴 Risk flags — anything broken or outdated
- 📋 Todo: [count] tasks — top 3 by priority
- 🔄 In Progress: [what is being worked on]
- 💡 Suggested focus — highest priority todo task
- 🛠️ Dev commands quick ref

At the very end of the report show a token usage meter:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 TOKEN USAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Used:      [████░░░░░░░░░░░░░░░░]  ~XX%  (~XXk / 200k)
Remaining: [████████████████░░░░]  ~XX%  (~XXk tokens)
Status:    🟢 Safe / 🟡 Medium / 🔴 Critical
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 Safe 0–60%  → keep working
🟡 Medium 60–80% → wrap up current task, run /r-end soon
🔴 Critical 80%+ → run /r-end NOW before context cuts off
Tip: run /r-tokens anytime to check remaining context.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are now senior dev partner for this session.
Never ask to re-explain anything already in memory.
EOF

make_file ".claude/commands/system/r-end.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Save to .claude/tasks/eod/ only.

Session ending:
1. List all tasks completed this session
2. List all files changed
3. List all memory files updated
4. List anything unfinished or still in progress
5. Suggest what to pick up first tomorrow
6. Check if CLAUDE.md needs updating

Save to .claude/tasks/eod/YYYY-MM-DD-EOD-summary.md
Confirm saved. Remind: this file is personal and gitignored.
EOF

make_file ".claude/commands/system/r-task.md" << 'EOF'
> ⚠️ PROJECT SCOPED: All outputs save to .claude/ only.

## Local Cache First
1. Read .claude/skills/_base.md           ← rules + patterns (fast)
2. Read .claude/skills/_stack.md          ← stack guidance (fast)
3. Read .claude/skills/_modules-index.md  ← module map (fast)
Only read .claude/modules/[specific].md if this task touches that module.
Only read .claude/memory/ files if skills/ cache is cold (🔴).

## Execute
4. Read .claude/memory/pre-task-checklist.md — complete every item
5. Read .claude/modules/[relevant].md if needed
6. State complete plan before writing any code
7. Wait for approval if change touches more than 3 files
8. Execute the task
9. Read .claude/memory/post-task-checklist.md — complete every item
10. Update all affected .claude/modules/ files
11. Update .claude/skills/_modules-index.md if modules changed
12. Save log to .claude/tasks/logs/YYYY-MM-DD-[title].md

Log format:
# Task: [title]
**Date**: **Summary**: **Files Changed**: **Modules Affected**:
**Decisions Made**: **Memory Updated**: **Cache Updated**: **Notes**:

Confirm log saved with full path.
EOF

make_file ".claude/commands/system/r-plan.md" << 'CMDEOF'
> ⚠️ PROJECT SCOPED: Save to .claude/tasks/plans/ only.

## Local Cache First
1. Read .claude/skills/_base.md           ← rules + patterns
2. Read .claude/skills/_stack.md          ← stack guidance
3. Read .claude/skills/_modules-index.md  ← module map
Only go deeper into memory/ or modules/ if cache is cold.

Do NOT write any code yet.
Plan the requested feature:
4. Read full memory system (if cache is cold)
5. Read all relevant .claude/modules/ files
6. List all files to create/change/delete
7. List patterns to follow
8. List rules that apply
9. Map blast radius
10. List risks and gotchas
11. Write step by step execution order

Save to .claude/tasks/plans/YYYY-MM-DD-[feature]-PLAN.md
Confirm saved. Wait for explicit approval before coding.
CMDEOF

make_file ".claude/commands/system/r-fix.md" << 'EOF'
> ⚠️ PROJECT SCOPED: All reads and updates stay in .claude/ only.

## Local Cache First
1. Read .claude/skills/_base.md           ← includes top gotchas
2. Read .claude/skills/_modules-index.md  ← find the affected module fast
Only read full .claude/memory/gotchas.md or .claude/modules/ if cache is cold.

## Diagnose and fix
3. Read .claude/memory/gotchas.md if not covered by cache
4. Read .claude/modules/[relevant].md
5. Trace actual root cause — never guess
6. Explain what is broken and exactly why
7. Propose fix with clear reasoning
8. Apply the fix
9. Verify fix works
10. New gotcha? Add to .claude/memory/gotchas.md AND .claude/skills/_base.md
11. Update .claude/modules/[relevant].md gotchas section + changelog
12. Save log to .claude/tasks/logs/YYYY-MM-DD-fix-[title].md
EOF

make_file ".claude/commands/system/r-done.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Move files within .claude/tasks/ only.

Mark current task as done, then review quality.

## Finish
1. Read files in .claude/tasks/inprogress/
2. Identify task from context or ask
3. Get developer name from .claude/settings.local.json or git config
4. Update task file: Completed By, Completed Date, check off acceptance criteria, add Summary
5. Move: .claude/tasks/inprogress/ → .claude/tasks/done/
6. Save log to .claude/tasks/logs/YYYY-MM-DD-[title].md
7. Suggest git commit message for team

## Auto-review
8. Read .claude/skills/_base.md ← rules + patterns to check against
9. Check rules from .claude/memory/rules.md were followed
10. Check correct patterns were used
11. Check error handling is correct
Report: ✅ Pass / ❌ Fail per check. Flag any new gotchas or patterns to log.

Confirm task moved. Remind: commit and push so team sees it is done.
EOF

make_file ".claude/commands/system/r-todo.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Read/write .claude/tasks/ only.

Handles listing, adding, and picking up tasks.

## When called with no argument — show task board
1. Read all files in .claude/tasks/todo/
2. Read all files in .claude/tasks/inprogress/
3. Read last 5 files in .claude/tasks/done/

Report:
## 📋 Todo ([count])
| Priority | Task | Module | Effort | Added By |
|---|---|---|---|---|
[sorted: 🔴 first, then 🟡, then 🟢]

## 🔄 In Progress ([count])
| Task | Module | Assigned To | Started |
|---|---|---|---|

## ✅ Recently Done (last 5)
| Task | Module | Completed By |
|---|---|---|

After showing list: "Pick a task? Tell me which one and I'll move it to in-progress and start."

## When called with argument — add a new task
e.g. /r-todo add authentication rework
Infer developer name from .claude/settings.local.json or git config user.name.
Gather or infer: title, module, priority (🔴/🟡/🟢), description, acceptance criteria, effort.
Save to .claude/tasks/todo/YYYY-MM-DD-[title].md with full template:
# Task: [title]
**Added By**: **Date Added**: **Priority**: **Module**: **Estimated Effort**: **Assigned To**: unassigned
## Description / ## Acceptance Criteria / ## Notes / ## Related Files
Confirm saved. Remind: commit and push.

## When the user picks a task from the list
Move .claude/tasks/todo/[file] → .claude/tasks/inprogress/
Add: Assigned To + Started date.
Then automatically run /r-task with the task description.
Remind: commit and push so team knows it is taken.
EOF

make_file ".claude/commands/system/r-memory.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Read and write .claude/ only. SAFE MODE always active.
> SAFE MODE: NEVER delete or overwrite existing content. Only append or add missing.

Handles all memory maintenance. Behaviour depends on argument.

## /r-memory scan  — full project rescan (use after big changes)
1. Read every file in the project
2. For each file in .claude/memory/: read first, ADD missing sections, APPEND new findings
3. For each .claude/modules/ file: read first, append new findings only; create fresh if missing
4. Update CLAUDE.md missing sections only — never overwrite
5. Bump .claude/memory/VERSION minor version
Report: ✅ updated / ✅ created / ⏭️ skipped / ⚠️ nothing deleted / ⚠️ nothing overwritten

## /r-memory update  — incremental sync (use after a task)
1. Read changed files in the project since last task log
2. Compare against .claude/memory/ and .claude/modules/
3. ADD missing info only, APPEND new findings, flag outdated fields:
   <!-- previous: old value here -->
4. Set confidence: 🟢 High / 🟡 Medium / 🔴 Stale
5. Bump VERSION minor version
Report all changes made with file paths.

## /r-memory status  — health check (read-only)
Read all .claude/modules/ files and .claude/memory/VERSION.
Report:
| Module | Confidence | Last Updated | Notes |
|---|---|---|---|
Then: list all 🔴 Stale with fix action, 🟡 Medium with reason, overall health score.
Suggest: run /r-memory scan if 3+ modules are 🔴 Stale.

## /r-memory  (no argument) — defaults to status
EOF

make_file ".claude/commands/system/r-find.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Read from .claude/ only.

Find where something lives AND its blast radius — both in one pass.

## Local Cache First
1. Read .claude/skills/_modules-index.md ← check index before anything else
Cache hit: module listed with path → go directly to that file.
Cache miss: fall through to full search.

## Find location
2. Read .claude/memory/dependencies.md if needed
3. Read relevant .claude/modules/ files
4. Search actual codebase

## Blast radius
5. Trace direct and indirect dependencies from the located thing

## Report
### Location
- Exact file paths and line numbers
- Which module owns it
- What imports it / what it exports to

### Impact if changed
- Risk: 🟢 Low / 🟡 Medium / 🔴 High
- Direct impact (files + paths)
- Indirect impact (files + paths)
- Tests to check
- Recommendation
EOF

make_file ".claude/commands/system/r-log.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Save to .claude/memory/ and .claude/modules/ only.

Log a piece of project knowledge. Behaviour depends on type argument.

## /r-log decision [title]
Add to .claude/memory/decisions.md:
#### [today] — [title]
- **Problem**: - **Options Considered**: - **Decision**: - **Reason**:
- **Tradeoffs**: - **Revisit If**:
Confirm saved.

## /r-log gotcha [title]
1. Add to .claude/memory/gotchas.md
2. Add to .claude/modules/[relevant].md gotchas section
3. Append to module changelog
#### [Module] — [Title]
- **What Happens**: - **Why**: - **How to Avoid**: - **Discovered**: [today]
Confirm saved to both files.
Also update .claude/skills/_base.md gotchas section.

## /r-log pattern [name]
Add to .claude/memory/patterns.md:
#### [Pattern Name]
- **When to use**: - **Example**: [file path + snippet] - **Anti-pattern**:
Confirm saved.
Also update .claude/skills/_base.md patterns section.

## /r-log  (no type) — ask which type: decision / gotcha / pattern
EOF

make_file ".claude/commands/system/r-cache.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Read/write .claude/skills/ only.

Manages the local skill cache. Behaviour depends on argument.

## /r-cache warm  — rebuild all cache files from memory (do this after /r-memory scan)
1. Read .claude/memory/context.md, rules.md, patterns.md, gotchas.md, dependencies.md
2. Read ALL files in .claude/modules/

Rebuild _base.md with: project name + stack, top 10 rules, top 5 patterns, top 10 gotchas, timestamp.
Rebuild _stack.md with: stack + source folders, stack-specific rules, dev commands, timestamp.
Rebuild _modules-index.md with: one row per module (name | file | confidence | last updated), timestamp.

Report: ✅ _base.md / ✅ _stack.md / ✅ _modules-index.md rebuilt.
⚡ Cache is WARM — future commands load skills/ first.
Remind: commit .claude/skills/ so teammates benefit.

## /r-cache status  — check cache health (read-only)
Read all three cache files.
Report:
| File | Status | Generated | Size |
|---|---|---|---|
| _base.md | 🟢 Warm / 🔴 Cold | [timestamp] | [lines] lines |
| _stack.md | 🟢 Warm / 🔴 Cold | [timestamp] | [lines] lines |
| _modules-index.md | 🟢 Warm / 🔴 Cold | [timestamp] | [X] modules |
Overall: 🟢 All warm / 🟡 Partial / 🔴 All cold
Suggest /r-cache warm if any file is 🔴 Cold or timestamp is old.

## /r-cache  (no argument) — defaults to status
EOF

make_file ".claude/commands/system/r-tokens.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Read from .claude/ only.

Estimate current token usage for this session.

Calculate approximate tokens used based on:
- All memory files loaded this session
- All files read from the project
- Full conversation length so far
- All responses generated

Then display:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 TOKEN USAGE — Current Session
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Used:      [fill bar with █ and ░]  ~XX%  (~XXk / 200k)
Remaining: [fill bar with █ and ░]  ~XX%  (~XXk tokens)
Status:    🟢 Safe / 🟡 Medium / 🔴 Critical
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 Safe      0–60%  → keep working
🟡 Medium   60–80%  → wrap up task, run /r-end soon
🔴 Critical  80%+   → run /r-end NOW before cutoff
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Bar is 20 chars wide:
- Each █ = 5% used
- Each ░ = 5% remaining
- Example 60% used: ████████████░░░░░░░░

Note: This is an estimate based on conversation size.
Actual token count may vary slightly.
Run /r-end before hitting 85% to save session safely.
EOF

make_file ".claude/commands/system/r-help.md" << 'EOF'
> ⚠️ PROJECT SCOPED: Read from .claude/commands/ only.

Read .claude/commands/system/ and .claude/commands/custom/ and display all commands.

## System Commands (12)
| Command | Description |
|---|---|
| /r-start | Load session — skills cache first, then full memory |
| /r-end | End session — EOD summary + save |
| /r-task [desc] | Execute a task with full cache-first context |
| /r-plan [feature] | Plan a feature before writing any code |
| /r-fix [desc] | Diagnose and fix — cache-first gotcha check |
| /r-todo | List tasks / /r-todo add [desc] to add / pick from list to start |
| /r-done | Mark task done + auto quality review |
| /r-find [thing] | Location + blast radius in one pass |
| /r-log [type] [desc] | Log a decision / gotcha / pattern |
| /r-memory [scan|update|status] | Memory maintenance |
| /r-cache [warm|status] | Skill cache maintenance |
| /r-tokens | Token usage meter |

## Custom Commands
[list any found in .claude/commands/custom/]
[if empty: No custom commands yet — see .claude/commands/custom/README.md]
EOF

# ───────────────────────────────────────────────────────
# STEP 7: CUSTOM COMMANDS README
# ───────────────────────────────────────────────────────

print_step "Creating Custom Commands"

make_file ".claude/commands/custom/README.md" << 'EOF'
# Custom Commands
> ⚠️ PROJECT SCOPED: Save to .claude/commands/custom/ only.
> All custom commands use r- prefix.

## Template
Create: .claude/commands/custom/r-[name].md

Content:
---
> ⚠️ PROJECT SCOPED: All reads and writes stay within .claude/ only.
[Exact instructions for Claude to execute when this command is typed]
---

## To add a custom command
/r-task create custom command /r-[name] that does [description]

## Ideas
- /r-deploy   → your deployment steps
- /r-test     → run test suite your way
- /r-migrate  → database migration workflow
- /r-seed     → database seeding workflow
- /r-lint-fix → auto fix linting issues
EOF

# ───────────────────────────────────────────────────────
# STEP 8: UPDATE .gitignore
# ───────────────────────────────────────────────────────

print_step "Updating .gitignore"

GITIGNORE_BLOCK="
# ─────────────────────────────────────────────────────
# Claude AI Memory System
# Shared with team: everything in .claude/ except below
# ─────────────────────────────────────────────────────
.claude/settings.local.json
.claude/tasks/eod/
"

if [ -f ".gitignore" ]; then
  if grep -q "Claude AI Memory System" .gitignore; then
    print_warn ".gitignore already has Claude entries — skipping"
  else
    echo "$GITIGNORE_BLOCK" >> .gitignore
    print_ok "Appended to existing .gitignore"
  fi
else
  echo "$GITIGNORE_BLOCK" > .gitignore
  print_ok "Created .gitignore"
fi

# ───────────────────────────────────────────────────────
# STEP 9: UPDATE README.md
# ───────────────────────────────────────────────────────

print_step "Updating README.md"

README_BLOCK="
## 🧠 Claude AI Development System

This project uses a shared Claude Code memory system in \`.claude/\`

### First time setup
\`\`\`bash
npm install -g @anthropic-ai/claude-code
claude
\`\`\`
Then add your name to \`.claude/settings.local.json\`:
\`\`\`json
{ \"developerName\": \"Your Name Here\" }
\`\`\`
Then run \`/r-memory-scan\` to build your memory.

### Daily workflow
\`\`\`
/r-start              → load memory, see project status
/r-todo               → see all pending tasks
/r-pickup             → pick up a task to work on
/r-task [desc]        → execute any task
/r-plan [feature]     → plan a big feature before coding
/r-fix [desc]         → diagnose and fix a bug
/r-done               → mark current task as complete
/r-end                → end of day summary
\`\`\`

### Team rules
- Commit all \`.claude/\` changes after tasks
- Only \`settings.local.json\` and \`tasks/eod/\` are personal/gitignored
- Add tasks for teammates with \`/r-add-task\`
- Update module memory after touching any module
"

if [ -f "README.md" ]; then
  if grep -q "Claude AI Development System" README.md; then
    print_warn "README.md already has Claude section — skipping"
  else
    echo "$README_BLOCK" >> README.md
    print_ok "Appended to existing README.md"
  fi
else
  echo "# $PROJECT_NAME $README_BLOCK" > README.md
  print_ok "Created README.md"
fi

# ───────────────────────────────────────────────────────
# DONE
# ───────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Claude AI Development System Setup Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Project:${NC}   $PROJECT_NAME"
echo -e "${CYAN}Stack:${NC}     $STACK"
echo -e "${CYAN}Date:${NC}      $TODAY"
if [ "$SAFE_MODE" = true ]; then
  echo -e "${YELLOW}Mode:${NC}      ⚠️  SAFE MODE — existing files were not touched"
else
  echo -e "${CYAN}Mode:${NC}      🆕 Fresh setup — all files created"
fi

# ─────────────────────────────────────────────────────
# INTERACTIVE: Developer name
# ─────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}═══ Developer Setup ═══${NC}"
echo ""
echo -e "${CYAN}What is your name?${NC}"
echo -e "  This gets saved to ${YELLOW}.claude/settings.local.json${NC} so Claude knows who you are."
echo -e "  ${YELLOW}(Press Enter to skip)${NC}"
echo ""
read -r -p "  Your name: " DEV_NAME
echo ""

if [ -n "$DEV_NAME" ]; then
  # Try python3 first (clean JSON rewrite), fall back to sed
  if command -v python3 > /dev/null 2>&1; then
    python3 - "$DEV_NAME" << 'PYEOF'
import json, sys
path = ".claude/settings.local.json"
try:
    with open(path, "r") as f:
        data = json.load(f)
    data["developerName"] = sys.argv[1]
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
except Exception as e:
    sys.exit(1)
PYEOF
    if [ $? -eq 0 ]; then
      print_ok "Name \"$DEV_NAME\" saved to .claude/settings.local.json"
    else
      print_warn "Could not write JSON — trying sed fallback"
      sed -i "s/\"developerName\": \"\"/\"developerName\": \"$DEV_NAME\"/" .claude/settings.local.json \
        && print_ok "Name \"$DEV_NAME\" saved to .claude/settings.local.json" \
        || print_warn "Failed — add your name manually to .claude/settings.local.json"
    fi
  else
    sed -i "s/\"developerName\": \"\"/\"developerName\": \"$DEV_NAME\"/" .claude/settings.local.json \
      && print_ok "Name \"$DEV_NAME\" saved to .claude/settings.local.json" \
      || print_warn "Failed — add your name manually to .claude/settings.local.json"
  fi
else
  print_warn "Skipped — add your name later in .claude/settings.local.json"
fi

# ─────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

# Remind about name only if skipped
if [ -z "$DEV_NAME" ]; then
  echo -e "${YELLOW}One manual step:${NC}"
  echo "  Add your name to .claude/settings.local.json:"
  echo "    { \"developerName\": \"Your Name\" }"
  echo ""
fi

echo -e "${YELLOW}Open Claude Code and run these two commands:${NC}"
echo ""
echo -e "  ${CYAN}1.${NC} /r-memory scan    ← scans codebase, builds memory (1-3 min)"
echo -e "  ${CYAN}2.${NC} /r-cache warm     ← compiles skills/ cache from memory"
echo ""
echo -e "  Then commit: ${YELLOW}git add .claude/ CLAUDE.md && git push${NC}"
echo ""
echo -e "${YELLOW}Daily workflow:${NC}"
echo "  /r-start  → load session"
echo "  /r-todo   → see / add / pick tasks"
echo "  /r-task   → do the work"
echo "  /r-done   → finish + auto review"
echo "  /r-end    → end of day"
echo ""
echo -e "${GREEN}Happy coding! 🚀${NC}"
echo ""