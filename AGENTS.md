# Agent Instructions

## Agent Roles

This repository uses multiple agent roles.

### Writer Agent (main branch only)
- Scope: Works on `main` only and is responsible for delivering code changes
- Allowed: Modify code, run quality gates, commit, and push to `main`
- Required: Follow the "Landing the Plane" workflow every session
- Issue workflow: Uses Beads to select, track, and complete work

### Reader Agent (NO CODE WRITES)
- Scope: Read-only review on `main`
- Prohibited: Any code edits, commits, pushes, or branch changes
- Allowed activity:
  - Create Beads issues
  - Add review notes
  - Review recent commits on `main`
- All contributions are recorded via Beads notes or new issues

## Reader Agent Workflow (Required)

Reader agents operate in a read-only capacity.

Allowed commands:
```bash
bd sync
bd list
bd show <id>
bd new "<issue title>"
bd note <id> "<review or suggestion>"
git checkout main  # only to ensure you're on main
git pull --rebase
git log
git show <commit>
```

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Quick reference:**
- `bd ready` - Find unblocked work
- `bd create "Title" --type task --priority 2` - Create issue
- `bd close <id>` - Complete work
- `bd sync` - Sync with git (run at session end)

For full workflow details: `bd prime`

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
