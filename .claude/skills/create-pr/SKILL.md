---
name: create-pr
description: Open a GitHub pull request from a source branch into the repo's default branch (main), with a title and description generated from the actual diff/commits. Use when the user asks to create/open a PR, or as the final step inside another skill (e.g. work-on-issue) once work on a branch is done.
---

# Create PR

Input: a source branch name (defaults to the current branch if not given).

## Steps

1. **Resolve the source branch.** If not given explicitly, use the current branch (`git branch --show-current`). Refuse to open a PR from `main`/the default branch itself.

2. **Push it.** Ensure the branch is pushed and up to date:
   ```bash
   git push -u origin <branch>
   ```

3. **Determine the default/base branch.** Usually `main` — confirm with `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` rather than assuming.

4. **Review the actual changes**, not just the latest commit:
   ```bash
   git log <base>..<branch>
   git diff <base>...<branch>
   ```

5. **Draft title and body:**
   - Title: short (under 70 chars), imperative, describes the change — not the branch name verbatim.
   - Body: use this structure —
     ```markdown
     ## Summary
     - bullet points on what changed and why (why > what)

     ## Related
     Closes #<issue-number>   (only if this PR resolves a tracked issue — infer from branch name/commits, or ask if unclear)

     ## Test plan
     - [ ] checklist of how this was/should be verified
     ```
   - Never invent a "Test plan" step that wasn't actually possible to run — write what genuinely applies.

6. **Create the PR:**
   ```bash
   gh pr create --base <default-branch> --head <branch> --title "<title>" --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   ```

7. Return the PR URL to the user/caller.

## Notes
- Never use `--no-verify` or bypass hooks.
- Do not merge the PR — this skill only opens it.
- If `gh` is not authenticated, tell the user rather than attempting workarounds.
