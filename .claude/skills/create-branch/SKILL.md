---
name: create-branch
description: Create a git branch from a title or description, with a type prefix (feature/, bug/, doc/, chore/, etc.) and a lowercase dash-separated slug. Use when the user asks to create/start a branch, or as a step inside another skill (e.g. work-on-issue) that needs a branch before coding.
---

# Create Branch

Input: a title or short description (e.g. an issue title, or a plain request like "add dark mode toggle").

## Steps

1. **Check repo state.** Run `git status`. If there are uncommitted changes, stop and tell the user — do not branch over dirty state without asking.

2. **Pick the prefix** from the input's intent:
   - `feature/` — new capability or enhancement
   - `bug/` — fixing broken behavior
   - `doc/` — documentation only
   - `chore/` — tooling, deps, config, cleanup, refactor with no behavior change
   - `test/` — test-only changes
   - If genuinely ambiguous, default to `feature/`.

3. **Derive the slug** from the title:
   - Lowercase everything.
   - Strip issue-number prefixes like `#12` or `12.` and leading articles.
   - Replace spaces/punctuation with single dashes, collapse repeats, trim leading/trailing dashes.
   - Keep it short — aim for 3-6 words. Drop filler words (a, the, for, to) unless needed for meaning.
   - Example: "Live agent graph visualization" → `feature/live-agent-graph-visualization`
   - Example: "Fix: WebSocket drops on reconnect" → `bug/websocket-drops-on-reconnect`

4. **Ensure it's unique.** Run `git branch -a --list "<prefix><slug>*"`. If it already exists, append `-2`, `-3`, etc.

5. **Create and switch.** Branch from the current default branch's latest state:
   ```bash
   git fetch origin main
   git checkout -b <prefix><slug> origin/main
   ```
   (Use the repo's actual default branch if not `main`.)

6. Report the branch name created and confirm it tracks `origin/main` as its base.

## Notes
- Never force-create over an existing branch with the same name — pick a new name instead.
- This skill only creates the branch. It does not commit, push, or open a PR.
