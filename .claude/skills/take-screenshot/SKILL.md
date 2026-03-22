---
name: take-screenshot
description: Take a screenshot for the website. Use when the user wants to capture or update a website screenshot showing editor features. Works for both VS Code and Zed.
argument-hint: "[screenshot-name, e.g. completions-page]"
disable-model-invocation: true
---

# Take Editor Screenshot

Captures screenshots of VS Code and/or Zed showing Forge features and saves them to `website/src/assets/screenshots/`.

## SAFETY RULES — READ FIRST

- **NEVER** send keystrokes via AppleScript — they hit the FRONTMOST app, not the target process
- **NEVER** call `tell application "X" to activate` on ANY app
- **NEVER** steal focus from the user's current app
- Zed captures use **window ID** only (`screencapture -l`) — no region capture, no focus needed
- VS Code captures use **Playwright** in a headless browser — no focus needed

## Arguments

- `$ARGUMENTS` — the screenshot name without extension and without IDE prefix (e.g., `completions-page`, `hover-page`, `homepage-page`)

## VS Code Screenshots (Playwright)

VS Code screenshots are captured by `editors/vscode/screenshots/capture.mjs`. This script has **per-screenshot capture functions** that trigger the actual feature:

| Screenshot | Capture Function | What It Triggers |
|-----------|-----------------|-----------------|
| `completions` | `captureCompletions()` | Types `this.` to trigger IntelliSense dropdown |
| `diagnostics` | `captureDiagnostics()` | Introduces a type error for red squiggles |
| `hover` | `captureHover()` | Hovers over a method name for tooltip |
| `go-to-definition` | `captureGoToDefinition()` | Triggers Peek Definition overlay |
| `homepage` | `captureHomepage()` | Opens Calculator.cs with code visible |
| `profiler` | `captureProfiler()` | Opens Forge sidebar Profiler panel |

### Run VS Code Capture

```bash
REPO_ROOT="/Users/christianfindlay/Documents/Code/forge"

# Capture a single screenshot:
node "$REPO_ROOT/editors/vscode/screenshots/capture.mjs" completions

# Capture all screenshots:
node "$REPO_ROOT/editors/vscode/screenshots/capture.mjs"
```

### Tweaking VS Code Capture Scripts

If a VS Code screenshot doesn't show the correct feature:

1. **Read** `editors/vscode/screenshots/capture.mjs`
2. Find the capture function for that screenshot (e.g., `captureCompletions`)
3. **Edit** the function to fix the issue — adjust line numbers, CSS selectors, timing, or interaction steps
4. **Re-run** the capture for just that screenshot: `node capture.mjs completions`
5. **Verify** the output with the Read tool
6. **Repeat** until the screenshot shows the correct feature

## Zed Screenshots (screencapture)

Zed screenshots use the shell script at `.claude/skills/take-screenshot/capture.sh`.

### Screenshot-to-File Mapping

| Screenshot Name | File to Open |
|----------------|-------------|
| `completions-page` | `sidecars/Forge.Sidecar.CSharp/CSharpSidecar.cs` |
| `diagnostics-page` | `sidecars/Forge.Sidecar.CSharp/Workspace/DefinitionResolver.cs` |
| `hover-page` | `sidecars/Forge.Sidecar.CSharp/Hover/CSharpHoverBuilder.cs` |
| `go-to-definition-page` | `sidecars/Forge.Sidecar.CSharp/Workspace/SolutionLoader.cs` |
| `homepage-page` | `editors/vscode/test-fixtures/workspace/Calculator.cs` |
| `profiler-page` | `sidecars/Forge.Sidecar.CSharp/Workspace/WorkspaceManager.cs` |

### Run Zed Capture

```bash
REPO_ROOT="/Users/christianfindlay/Documents/Code/forge"
FILE_TO_OPEN="$REPO_ROOT/<file-from-table>"
OUTPUT_PATH="$REPO_ROOT/website/src/assets/screenshots/zed-$ARGUMENTS.png"

bash "$REPO_ROOT/.claude/skills/take-screenshot/capture.sh" "$FILE_TO_OPEN" "$OUTPUT_PATH"
```

**NOTE**: Zed captures can only show static code views. Features like completion dropdowns, hover tooltips, and diagnostics squiggles require Forge's LSP to be running in Zed. If the Zed screenshot doesn't show the feature, report this to the user — it may need manual capture.

## Verification (CRITICAL — DO NOT SKIP)

After capturing, you MUST verify every screenshot:

### 1. File Size Check

```bash
ls -la website/src/assets/screenshots/*-$ARGUMENTS.png
```

- Valid screenshot: **> 50 KB** (typically 80-350 KB)
- Broken screenshot: **< 50 KB** (likely 404 or blank)

### 2. Visual Inspection

Use the `Read` tool to view the screenshot image. Check:
- Dark theme with C# code and syntax highlighting
- No "Error response", "404", white/blank pages, or dialogs covering code

### 3. Feature-Specific Validation

The screenshot **MUST** visually demonstrate the feature. Plain code is NOT enough.

| Screenshot Name | MUST Show |
|----------------|-----------|
| `completions-page` | An **active completion/autocomplete dropdown** with suggestions visible |
| `diagnostics-page` | **Red/yellow squiggly underlines** on code indicating errors or warnings |
| `hover-page` | A **hover tooltip/popup** displaying type info or documentation |
| `go-to-definition-page` | **Peek definition overlay** or navigation evidence |
| `homepage-page` | General editor view with C# code (no specific feature required) |
| `profiler-page` | **Profiler panel or sidebar** visible with profiling-related UI |

### 4. Fix and Retry

If the screenshot is BROKEN or doesn't show the feature:

1. **Read** the capture script (`capture.mjs` for VS Code, `capture.sh` for Zed)
2. **Edit** the relevant capture function to fix the issue
3. **Re-run** the capture
4. **Verify** again
5. **Repeat** until correct — do NOT give up after one attempt

## Rules

- NEVER save a screenshot that shows a 404 error page, blank page, or dialog
- NEVER save a screenshot that doesn't show the feature it's supposed to demonstrate
- ALWAYS verify the screenshot visually by reading it back with the Read tool
- ALWAYS check for the feature-specific UI element (see table above)
- ALWAYS tweak the capture script and retry if the screenshot is wrong
- The screenshot viewport MUST be 1280x800 (VS Code) or 1280x720 (Zed) for consistency
- Report the final result: screenshot path, file size, whether it passed verification, and whether the correct feature is visible
