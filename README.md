# claude-router 
## 🧠 Claude AI Development System

This project uses a shared Claude Code memory system in `.claude/`

### First time setup
```bash
npm install -g @anthropic-ai/claude-code
claude
```
Then add your name to `.claude/settings.local.json`:
```json
{ "developerName": "Your Name Here" }
```
Then run `/r-memory-scan` to build your memory.

### Daily workflow
```
/r-start              → load memory, see project status
/r-todo               → see all pending tasks
/r-pickup             → pick up a task to work on
/r-task [desc]        → execute any task
/r-plan [feature]     → plan a big feature before coding
/r-fix [desc]         → diagnose and fix a bug
/r-done               → mark current task as complete
/r-end                → end of day summary
```

### Team rules
- Commit all `.claude/` changes after tasks
- Only `settings.local.json` and `tasks/eod/` are personal/gitignored
- Add tasks for teammates with `/r-add-task`
- Update module memory after touching any module

