---
name: work-on-issue
description: Take a GitHub issue (by number or title), branch, implement a fix/feature to resolve it, and open a PR — all delegated to a separate background agent running on Sonnet 5. Use when the user says "work on issue #N", "pick up issue X", "implement issue about Y", or similar.
---

# Work on Issue

Input: an issue number (`#7`, `7`) or a title/description close enough to match one.

This skill's job is to **delegate** the whole issue-to-PR flow to a separate agent, not to do the coding inline in the main conversation.

## Steps

1. **Resolve the issue.** Run `gh issue view <number>` if a number was given. If only a title/description was given, run `gh issue list --search "<terms>"` and match; if more than one plausible match, ask the user which one before proceeding.

2. **Confirm scope with the user** if the issue is large/ambiguous or touches infra/security-sensitive code — this skill is meant for well-scoped issues. Don't confirm for routine, clearly-scoped ones; use judgment per the auto-mode guidance already in effect.

3. **Spawn the agent.** Use the `Agent` tool with:
   - `subagent_type`: `general-purpose`
   - `model`: `sonnet`
   - `isolation`: `worktree` (keeps this from colliding with any other in-progress work in the main checkout)
   - `run_in_background`: true (default) unless the user is actively waiting and asked to watch
   - A **self-contained prompt** containing:
     - The full issue number, title, body, and acceptance criteria (paste them in — the agent has no access to this conversation).
     - Explicit instructions to:
       1. Use the `create-branch` skill to branch from the issue title (this repo's convention: `feature/`, `bug/`, `doc/`, `chore/`, `test/` prefix + dash-slug).
       2. Implement the change needed to satisfy the issue's acceptance criteria. Follow the repo's existing conventions (check `CLAUDE.md`, package.json/lockfiles, existing code style) rather than inventing new patterns.
       3. Run relevant tests/build/lint if they exist; fix failures before proceeding.
       4. Commit with a message describing why, following this repo's commit message style (check `git log` for examples).
       5. Push and use the `create-pr` skill to open a PR into `main`, with the PR body including `Closes #<issue-number>`.
     - Tell it to report back the branch name and PR URL when done.

4. **On completion**, relay the branch name and PR URL to the user. Do not merge, do not push further changes yourself — that's a separate, explicit ask.

## Notes
- One issue per invocation. For multiple issues, call this skill once per issue (parallel background agents are fine if issues are independent; check the dependency graph/issue "Depends on" field first — don't start an issue whose dependencies aren't merged yet, unless the user explicitly overrides).
- If the repo has no `create-branch`/`create-pr` skills available to the spawned agent, tell the user instead of having the agent improvise branch/PR conventions.
- Never give the spawned agent permission to force-push, merge, or delete branches.
