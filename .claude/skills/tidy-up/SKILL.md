# Skill: Tidy Up

Run lint, test, and build checks, then update any affected documentation. Use `/tidy-up` when you're done with work but weren't using tasks.

## Steps

1. Run the task completion checks:
   ```bash
   "$CLAUDE_PROJECT_DIR"/.claude/hooks/task-completion-checks.sh
   ```
2. If any check fails, fix the issues and re-run until all pass.
3. Once checks pass, update any docs (CLAUDE.md, SKILL.md, prompts, README.md) and project memory files affected by your changes. Skip what's already accurate.
