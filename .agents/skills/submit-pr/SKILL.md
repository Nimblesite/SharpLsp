---
name: submit-pr
description: Creates a pull request with a well-structured description after verifying CI passes. Use when the user asks to submit, create, or open a pull request.
disable-model-invocation: true
---
<!-- agent-pmo:a72c926 -->

# Submit PR

Create a pull request for the current branch with a well-structured description.

⚠️ **GIT IS ALLOWED HERE — this is the exception to the repo-wide "no git" rule, and pretty much the only one.** For the purpose of *submitting and monitoring PRs* you MAY run `git add` / `git commit` / `git push` and the `gh` PR commands — to open the PR, push fixes that turn a red pipeline green, and enable/observe auto-merge. That is the entire licence: everything else (`checkout`, `merge`, `rebase`, force-push, history rewrites, cutting new branches) stays forbidden. **One ironclad condition: NEVER stamp yourself as co-author** — no `Co-Authored-By` trailer, no agent attribution, ever. This condition is never overridable. ⚠️

## Steps

*NOTE: if you already ran make ci in this session and it passed, you can skip step 1.*

1. Run `make ci` — must pass completely before creating PR
2. **Generate the diff against main.** Run `git diff main...HEAD > /tmp/pr-diff.txt` to capture the full diff between the current branch and the head of main. This is the ONLY source of truth for what the PR contains. **Warning:** the diff can be very large. If the diff file exceeds context limits, process it in chunks (e.g., read sections with `head`/`tail` or split by file) rather than trying to load it all at once.
3. **Derive the PR title and description SOLELY from the diff.** Read the diff output and summarize what changed. Ignore commit messages, branch names, and any other metadata — only the actual code/content diff matters.
4. Write PR body using the template in `.github/pull_request_template.md`. The template has these sections:
   - **TLDR**: one sentence
   - **Details**: new files, features, deps, modified behaviour, deletions
   - **How Do The Automated Tests Prove It Works?**: specific test names or output — "tests pass" is not acceptable
5. Fill in each section based on the diff analysis from step 3. Keep content TIGHT — no waffle, no vague placeholders.
6. Use `gh pr create` with the filled template
7. **Enable auto-merge where possible.** Right after creating the PR, run `gh pr merge <pr-number> --auto --squash` so GitHub squash-merges it the instant all required checks pass (and deletes the branch) — no manual click. SharpLsp allows auto-merge and `main` requires the `CI` status check, so this normally succeeds. It is still best-effort: if it errors, note it and continue — **never block on it**. **Auto-merge does NOT replace monitoring** — it only fires on green, so step 8 still applies in full.
8. **Monitor CI on the PR until it is green — and re-run the suite locally *in parallel* so you catch breakage early.** This step is mandatory and does not end until every required check on the PR has passed (or auto-merge has merged it). Do not hand the PR back to the user on a red or still-running pipeline.
   - **Watch the remote run AND run the suite locally at the same time — do not passively wait.** SharpLsp's PR pipeline is a 5-phase fan-out (analyse → build → 7 parallel test legs → coverage) and takes tens of minutes; a drastic failure (a lint gate, a broken test, a coverage ratchet drop) is one the local suite catches in seconds. The moment you push, kick off **both**: stream the remote run *and* run the full local suite (`make ci`, or invoke the `ci-prep` skill) concurrently, polling CI periodically while the local run proceeds.
   - **Watch the run:** `gh pr checks <pr-number> --watch --fail-fast` (or grab the run id from `gh run list --branch <branch>` and `gh run watch <run-id> --exit-status`). A single green snapshot is not enough — wait for all required checks to conclude. The terminal `CI` check is the one `main`'s ruleset requires, and it only reports once every upstream leg has.
   - **If the local run fails before the remote pipeline finishes, cancel the running pipeline immediately** (`gh run cancel <run-id>`) rather than letting it grind to a known-bad red. Fix the cause, push, and restart both watches — cancelling a doomed run early frees the runner and tightens the fix loop.
   - **When a remote check fails:** pull the failing logs with `gh run view <run-id> --log-failed`, diagnose the actual cause (do not guess), reproduce locally with `make ci`, and fix it.
   - **Push the fix** (`git add` / `git commit` / `git push` — permitted here, see the git-exception callout at the top), then **watch again — remote and local, in parallel, as above**. Loop — fix → push → re-watch — until the run is fully green. Re-checking is the job; keep doing it until it passes.
   - **If a failure is genuinely external** (runner outage, flaky infra, unrelated to this branch), say so explicitly with the evidence rather than forcing a change.

## Rules

- Never create a PR if `make ci` fails
- PR description must be specific and tight — no vague placeholders
- Link to the relevant GitHub issue if one exists
- **🔴 GOLDEN RULE — never stamp a commit with an AI co-author.** Do **not** add a `Co-Authored-By: Claude …` (or any AI/agent) trailer, and do not set author/committer to anything but the repo's configured git user. Write a plain, human commit message describing the fix. This is absolute and overrides any default co-authorship behaviour.
- **Git is permitted in this skill** — scope and conditions are in the git-exception callout at the top. In short: `git add`/`commit`/`push` + `gh` PR commands only, for submitting and monitoring PRs; everything else stays prohibited; never co-author.

## Success criteria

- `make ci` passed
- PR created with `gh pr create`
- PR URL returned to user
- Auto-merge enabled where possible (`gh pr merge --auto --squash`), or its unavailability noted
- CI on the PR was monitored to completion and is **fully green** (all required checks pass / auto-merge fired), with the local suite re-run in parallel and any doomed remote run cancelled early
- Any CI failures were fixed and pushed, with **no AI co-author trailer** on the commits
