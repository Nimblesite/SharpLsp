---
name: submit-pr
description: Create and submit a GitHub pull request using the diff against main
disable-model-invocation: true
allowed-tools: Bash(git *), Bash(gh *)
---

# Submit Pull Request

Create a GitHub pull request for the current branch.

## Steps

1. Get the diff against the latest LOCAL main branch commit:

```
git diff main...HEAD
```

2. Read the diff output carefully. Do NOT look at commit messages. The diff is the only source of truth for what changed.

3. Check if there's a related GitHub issue. Look for issue references in the branch name (e.g. `42-fix-bug` or `issue-42`). If found, fetch the issue title:

```
gh issue view <number> --json title -q .title
```

4. Write the PR content using the project's PR template

You read the file at .github/PULL_REQUEST_TEMPLATE.md

Keep content TIGHT. Don't add waffle.

5. Construct the PR title:
- If an issue number was found: `#<number>: <short description>`
- Otherwise: `<short description>`
- Keep under 70 characters

6. Commit changes and push the current branch if needed:

```
git push -u origin HEAD
```

DO NOT include yourself as a a coauthor!

7. Create the PR using `gh`:

```
gh pr create --title "<title>" --body "$(cat <<'EOF'
# TLDR;
<tldr content>

# Details
<details content>

# How do the tests prove the change works
<test description>
EOF
)"
```

8. Return the PR URL to the user.
