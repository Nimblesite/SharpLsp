---
name: take-screenshot
description: Take a screenshot of Zed editor for the website. Use when the user wants to capture or update a website screenshot showing editor features.
argument-hint: "[screenshot-name, e.g. completions-page]"
disable-model-invocation: true
---

# Take Zed Editor Screenshot

Captures a screenshot of Zed editor showing a C# file and saves it to `website/src/assets/screenshots/`.

## SAFETY RULES — READ FIRST

- **NEVER** send keystrokes via AppleScript — they hit the FRONTMOST app, not the target process
- **NEVER** call `tell application "X" to activate` on ANY app
- **NEVER** steal focus from the user's current app
- Capture by **window ID** only (`screencapture -l`) — no region capture, no focus needed
- Close Zed windows via the **close button UI element**, not keyboard shortcuts

## Arguments

- `$ARGUMENTS` — the screenshot filename without extension (e.g., `completions-page`, `hover-page`, `homepage-page`)

## Screenshot-to-File Mapping

Each screenshot should open a different C# file for visual variety:

| Screenshot Name | File to Open |
|----------------|-------------|
| `completions-page` | `sidecars/Forge.Sidecar.CSharp/CSharpSidecar.cs` |
| `diagnostics-page` | `sidecars/Forge.Sidecar.CSharp/Workspace/DefinitionResolver.cs` |
| `hover-page` | `sidecars/Forge.Sidecar.CSharp/Hover/CSharpHoverBuilder.cs` |
| `go-to-definition-page` | `sidecars/Forge.Sidecar.CSharp/Workspace/SolutionLoader.cs` |
| `homepage-page` | `editors/vscode/test-fixtures/workspace/Calculator.cs` |
| `profiler-page` | `sidecars/Forge.Sidecar.CSharp/Workspace/WorkspaceManager.cs` |

If the screenshot name is not in this table, default to `sidecars/Forge.Sidecar.CSharp/CSharpSidecar.cs`.

## Step 1: Run the Capture Script

The capture script rebuilds the Zed extension, opens the file in a new Zed window, captures by window ID, and closes the window. It does NOT steal focus.

```bash
REPO_ROOT="/Users/christianfindlay/Documents/Code/forge"
FILE_TO_OPEN="$REPO_ROOT/<file-from-table>"
OUTPUT_PATH="$REPO_ROOT/website/src/assets/screenshots/$ARGUMENTS.png"

bash "$REPO_ROOT/.claude/skills/take-screenshot/capture.sh" "$FILE_TO_OPEN" "$OUTPUT_PATH"
```

## Step 2: Verify the Screenshot is Correct

This step is CRITICAL. You MUST verify the screenshot. Do NOT skip this step.

1. Check the file size using `ls -la website/src/assets/screenshots/$ARGUMENTS.png`
   - A valid Zed screenshot is **> 50 KB** (typically 80-350 KB)
   - A broken screenshot (404 error page) is approximately **~20 KB**
   - If the file is < 50 KB, the screenshot is **BROKEN** — retry from Step 1

2. Use the `Read` tool to visually inspect the saved screenshot file
   - The image MUST show the Zed editor with a **dark theme** and C# code with syntax highlighting
   - If the image shows "Error response", "404", a white/blank page, or a dialog covering the code, the screenshot is **BROKEN**
   - Report clearly to the user whether the screenshot is CORRECT or BROKEN

## Step 3: Handle Failures

If the screenshot is broken:
1. Check if Zed is running: `pgrep -x zed`
2. Check Screen Recording permission: System Settings > Privacy > Screen Recording > Terminal/VS Code
3. Retry up to 2 times before giving up

## Rules

- NEVER save a screenshot that shows a 404 error page, blank page, or dialog
- ALWAYS verify the screenshot visually by reading it back with the Read tool
- The screenshot viewport MUST be 1280x720 for consistency
- Report the final result: screenshot path, file size, and whether it passed verification
