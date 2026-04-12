---
name: take-screenshot
description: Take a screenshot for the website. Use when the user wants to capture or update a website screenshot showing editor features. Works for both VS Code and Zed.
argument-hint: "[screenshot-name, e.g. completions, split-editor, code-folding]"
disable-model-invocation: true
---

# Take Editor Screenshot

Captures screenshots of VS Code and/or Zed showing **Forge features** and saves them to `website/src/assets/screenshots/`.

## CRITICAL: BUILD AND INSTALL BEFORE CAPTURING

**You MUST build and install the latest VSIX before capturing ANY screenshot.**
The capture script uses `code serve-web` which runs a SEPARATE VS Code instance. If you don't install the latest VSIX, the screenshots will show stale or missing Forge features.

### Step 1: Build the VSIX

```bash
cd /Users/christianfindlay/Documents/Code/forge

# Full build (Rust binary + .NET sidecar + VSIX):
make build

# OR if binaries are already built, just package the VSIX:
make build-vsix
```

This produces `forge.vsix` in the repo root (or `editors/vscode/forge-0.1.0.vsix`).

### Step 2: Install to BOTH desktop and serve-web

The capture script (`capture.mjs`) handles installation automatically — it runs:
```bash
code --install-extension <vsix> --force
code --install-extension <vsix> --force --extensions-dir ~/.vscode-server/extensions
```

**If you skip the build, you get stale screenshots that don't show Forge features.**

## SAFETY RULES

- **NEVER** send keystrokes via AppleScript — they hit the FRONTMOST app, not the target process
- **NEVER** call `tell application "X" to activate` on ANY app
- **NEVER** steal focus from the user's current app
- Zed captures use **window ID** only (`screencapture -l`) — no focus needed
- VS Code captures use **Playwright** in a headless browser — no focus needed

## Arguments

- `$ARGUMENTS` — the screenshot name (e.g., `completions`, `split-editor`, `code-folding`, `nested-classes`, `homepage`)

## What Are Forge Features?

Screenshots MUST show **Forge-specific functionality**, not generic VS Code features. Forge provides:

- **Solution Explorer tree view** — the `forge-explorer` activity bar icon with `forge.solutionExplorer` tree showing .NET solution structure (projects, files, dependencies)
- **Profiler panel** — `forge.profiler` tree view showing .NET process profiling
- **Code completions** — Roslyn-powered IntelliSense via the C# sidecar
- **Diagnostics** — error squiggles from Roslyn analysis
- **Hover info** — type/doc tooltips from Roslyn
- **Go to Definition** — symbol navigation via Roslyn
- **Document symbols / code folding / selection ranges** — tree-sitter powered, served by Forge's Rust host

The Solution Explorer tree is the most visible Forge-specific feature. If it doesn't appear, the extension isn't activated or the VSIX is stale.

## VS Code Screenshots (Playwright)

Captured by `editors/vscode/screenshots/capture.mjs`.

### Run VS Code Capture

```bash
REPO_ROOT="/Users/christianfindlay/Documents/Code/forge"

# ALWAYS build first:
make -C "$REPO_ROOT" build-vsix

# Capture a single screenshot:
cd "$REPO_ROOT/editors/vscode"
node screenshots/capture.mjs completions

# Capture all screenshots:
node screenshots/capture.mjs
```

### Tweaking Capture Functions

If a screenshot doesn't show the correct Forge feature:

1. **Read** `editors/vscode/screenshots/capture.mjs`
2. Find the capture function (e.g., `captureCompletions`)
3. **Edit** the function — adjust selectors, timing, interactions
4. **Re-run**: `node screenshots/capture.mjs <name>`
5. **Verify** with the Read tool (view the PNG)
6. **Repeat** until the screenshot shows the actual Forge feature

## Zed Screenshots (screencapture)

Shell script at `.claude/skills/take-screenshot/capture.sh`.

**NOTE**: Zed captures can only show static code views. Forge features (completions, hover, diagnostics) cannot be triggered programmatically in Zed. If the screenshot doesn't show a Forge feature, report to the user.

### Run Zed Capture

```bash
REPO_ROOT="/Users/christianfindlay/Documents/Code/forge"
FILE_TO_OPEN="$REPO_ROOT/<file-path>"
OUTPUT_PATH="$REPO_ROOT/website/src/assets/screenshots/zed-$ARGUMENTS.png"

bash "$REPO_ROOT/.claude/skills/take-screenshot/capture.sh" "$FILE_TO_OPEN" "$OUTPUT_PATH"
```

## ⚠️ CHECK THE CONTENT. CHECK IT AGAIN. THEN CHECK IT A THIRD TIME ⚠️ 

ABSOLUTELY CRITICAL STEP. 
REJECT WHEN THEN IMAGE DOES NOT HAVE THE CORRECT CONTENT
CHECK VERY CAREFULLY

**The capture script LIES. It says `[ok]` when the screenshot is GARBAGE. NEVER trust script output. NEVER.**

**YOU WILL BE WRONG.** You will glance at the image, see a heading, and assume content is there. YOU ARE WRONG. You will see a panel title and think "that's the tree." YOU ARE WRONG. A heading is NOT content. A panel title is NOT tree nodes. You MUST fight the urge to rubber-stamp and ACTUALLY LOOK AT THE IMAGE CONTENT.

**CHECK. RECHECK. CHECK AGAIN.** Three passes minimum. Not one. THREE.

### Step 1: Read the PNG with the Read tool

```
Read the PNG file with the Read tool to visually inspect it.
```

File size means NOTHING. A 93KB screenshot can be completely empty. A 101KB screenshot can show zero tree nodes. The ONLY way to verify is to READ THE IMAGE AND LOOK AT IT WITH YOUR ACTUAL EYES.

### Step 2: FIRST CHECK — scan the entire image

Look at the ENTIRE image. What do you see? Describe every panel, every area, every visible element. Do NOT focus on what you WANT to see. Describe what is ACTUALLY THERE.

### Step 3: SECOND CHECK — apply the PASS/FAIL criteria LITERALLY, word by word

For each screenshot type, there are SPECIFIC visual elements that MUST be present. Do NOT interpret loosely. Do NOT squint and imagine you see something. Do NOT assume content exists because a heading exists.

**A heading is NOT content. A panel title is NOT tree nodes. "SOLUTION EXPLORER" text is NOT a populated tree. An empty panel with a title is EMPTY. Say it out loud: EMPTY.**

Read each criterion word by word. Then look at the image. Then answer honestly: does the image contain EXACTLY what the criterion demands?

| Screenshot | PASS — you MUST see ALL of these | FAIL — if you see ANY of these, the screenshot is BROKEN |
|-----------|-----------------------------------------------|-----------------------------------------------------|
| `solution-explorer` | Tree nodes with project names (e.g. "TestFixtures"), file names (e.g. ".cs" files), and expand/collapse arrows UNDER the "Solution Explorer" heading. At least 3+ tree items must be visible. You must be able to READ the names of the tree nodes. | Empty panel with just the "SOLUTION EXPLORER" heading and no tree nodes. Only 1-2 items. No file names visible. Cannot read any node text. |
| `completions` | A **dropdown overlay** with multiple completion suggestion rows (method names, property names, type names). The dropdown must be floating OVER the code with at least 3+ visible suggestion items. | Just code with no dropdown. An empty or single-item dropdown. |
| `diagnostics` | **Red or yellow wavy underlines** beneath code tokens. The squiggles must be clearly visible on at least one line. Wavy, not straight. | Clean code with no underlines. Straight underlines (those are find/replace highlights, not diagnostics). |
| `hover` | A **floating tooltip/popup box** above or below code showing type signature, documentation, or parameter info. Must be clearly a tooltip, not a notification. | Just code with no popup. A command palette or notification instead of a hover tooltip. |
| `go-to-definition` | A **peek definition inline overlay** showing source code in a bordered sub-editor, OR evidence of navigation to a different file. | Just code with no overlay or navigation evidence. |
| `profiler` | The **Profiler tree view** with actual .NET process entries (PIDs, names, memory). Real data, not placeholder text. | "No .NET processes found" or an empty profiler panel. |
| `homepage` | Code editor with C# syntax highlighting AND "Forge" visible in the status bar. | No Forge branding visible. Error dialogs covering the editor. |
| `editor-overview` | **Outline panel** with hierarchical symbol nodes (namespaces, classes, methods) populated by Forge. At least 3+ symbol nodes. | Empty outline panel or just "No symbols found". |

### Step 4: THIRD CHECK — name every element or it's a FAIL

After reading the image, you MUST explicitly list the specific visual elements you found:

**PASS format** (you MUST use this exact format):
```
VERIFICATION CHECKLIST:
- [ ] Read the PNG with Read tool: YES
- [ ] First check — full image scan: [describe every panel and area]
- [ ] Second check — criteria applied: [quote the specific criterion and match against image]
- [ ] Third check — named elements: I can see: [element 1], [element 2], [element 3], ...
RESULT: PASS — [specific reason with named elements]
```

**FAIL format**:
```
VERIFICATION CHECKLIST:
- [ ] Read the PNG with Read tool: YES
- [ ] First check — full image scan: [describe every panel and area]
- [ ] Second check — criteria applied: [quote the specific criterion and what's missing]
- [ ] Third check — named elements: CANNOT identify required elements
RESULT: FAIL — [what's actually there] vs [what's required]
```

**If you cannot name at least 3 specific visible elements by name, IT IS A FAIL.** "Appears to have some items" is a FAIL. "Seems to show content" is a FAIL. "Looks like there might be nodes" is a FAIL. NAME THEM OR FAIL IT.

### Step 5: If FAIL — fix it, don't save it

**Do NOT save a broken screenshot. Do NOT move on. Do NOT tell the user it passed.**

1. Diagnose WHY the feature isn't showing:
   - **Empty Solution Explorer**: No `.sln` file in the workspace (check for `.sln` not just `.slnx`), or sidecar hasn't loaded
   - **No completions dropdown**: Sidecar not running, or `this.` typed too early before LSP ready
   - **No diagnostics squiggles**: Pull diagnostics not implemented or broken
   - **No hover tooltip**: Sidecar can't load the workspace project
   - **No profiler entries**: No .NET processes running
2. Fix the root cause (workspace files, capture timing, capture function logic)
3. Re-run the capture
4. Re-verify with the Read tool — go back to Step 1 AND DO ALL THREE CHECKS AGAIN
5. **Repeat until the screenshot genuinely shows the feature, or report to the user that the feature is broken and cannot be captured**

### ABSOLUTE PROHIBITIONS

- NEVER say "the screenshot looks good" without completing ALL THREE CHECKS and naming specific elements
- NEVER assume a screenshot is correct because the script said `[ok]` — THE SCRIPT LIES
- NEVER pass a screenshot that shows an empty panel, missing overlay, or absent UI element
- NEVER confuse a panel HEADER (e.g. "SOLUTION EXPLORER") with actual CONTENT (tree nodes with files) — a HEADER IS NOT CONTENT, a HEADER IS NOT CONTENT, a HEADER IS NOT CONTENT
- NEVER save a screenshot showing "No .NET processes found" as a valid profiler screenshot
- NEVER use vague language like "appears to have some items" or "seems to show content" — NAME the specific elements or it's a FAIL
- NEVER glance at a thumbnail and call it done — LOOK at the actual content in the image
- NEVER skip the three-check process — if you skip it, you WILL pass a broken screenshot because you WILL fool yourself

## Rules

- **ALWAYS** build the VSIX before capturing (`make build-vsix`)
- NEVER save a screenshot that shows a 404, blank page, or error dialog
- NEVER save a screenshot that doesn't show the actual Forge feature with real content
- ALWAYS verify visually by reading the PNG back with the Read tool
- ALWAYS use dark theme
- Viewport: 1280x800 (VS Code) or 1280x720 (Zed)
- If a feature is genuinely broken (LSP doesn't support it yet), **tell the user** — do not silently save a broken screenshot
- Report: screenshot path, file size, PASS or FAIL, what is actually visible in the image
