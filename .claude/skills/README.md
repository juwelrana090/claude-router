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
