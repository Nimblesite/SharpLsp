#!/usr/bin/env bash
set -euo pipefail

# capture.sh — Capture a screenshot of Zed editor showing a C# file
# Usage: ./capture.sh <file-to-open> <output-path.png> [width] [height]
#
# SAFETY: This script NEVER sends keystrokes (they hit the frontmost app,
# which may not be Zed). It NEVER calls 'activate' on any app.
# It captures by window ID so Zed does not need to be in front.
# Output filenames MUST be prefixed with the IDE name (e.g. zed-completions-page.png).

FILE_TO_OPEN="${1:?Usage: capture.sh <file-to-open> <output-path.png> [width] [height]}"
OUTPUT_PATH="${2:?Usage: capture.sh <file-to-open> <output-path.png> [width] [height]}"
WIDTH="${3:-1280}"
HEIGHT="${4:-720}"
XPOS=50
YPOS=50
MIN_SIZE=50000

# Safety: ensure output filename has an IDE prefix to prevent overwrites
BASENAME=$(basename "$OUTPUT_PATH")
if [[ ! "$BASENAME" =~ ^(zed|vscode)- ]]; then
    echo "ERROR: Output filename must start with 'zed-' or 'vscode-' to prevent overwrites: $BASENAME" >&2
    exit 1
fi

if [ ! -f "$FILE_TO_OPEN" ]; then
    echo "ERROR: File not found: $FILE_TO_OPEN" >&2
    exit 1
fi

# Rebuild and install the Zed extension so screenshots show the latest version
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
echo "Rebuilding Zed extension..."
if ! make -C "$REPO_ROOT" build-zed 2>&1; then
    echo "WARNING: Zed extension build failed, continuing with existing version" >&2
fi

echo "Opening $FILE_TO_OPEN in a new Zed window..."
zed -n "$FILE_TO_OPEN"
sleep 5

echo "Positioning Zed window to ${WIDTH}x${HEIGHT} at (${XPOS},${YPOS})..."
osascript -e "
tell application \"System Events\"
    tell process \"zed\"
        set position of front window to {${XPOS}, ${YPOS}}
        set size of front window to {${WIDTH}, ${HEIGHT}}
    end tell
end tell
"
sleep 2

# Find the Zed main window ID via CGWindowList (no focus needed)
echo "Finding Zed window ID..."
WINDOW_ID=$(swift -e '
import Cocoa
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
        guard (w["kCGWindowOwnerName"] as? String) == "Zed" else { continue }
        let b = w["kCGWindowBounds"] as? [String: Any] ?? [:]
        let width = b["Width"] as? Int ?? 0
        let height = b["Height"] as? Int ?? 0
        if width >= 1000 && height >= 500 {
            print(w["kCGWindowNumber"] as? Int ?? 0)
            break
        }
    }
}
' 2>/dev/null)

if [ -z "$WINDOW_ID" ] || [ "$WINDOW_ID" = "0" ]; then
    echo "ERROR: Could not find Zed window ID" >&2
    exit 1
fi

echo "Capturing Zed window ID $WINDOW_ID (no focus steal)..."
if ! screencapture -x -o -l "$WINDOW_ID" "$OUTPUT_PATH" 2>/dev/null; then
    echo "ERROR: screencapture -l failed. Grant Screen Recording permission in System Settings." >&2
    exit 1
fi

# Close the Zed window via its close button (UI element, NOT a keystroke)
echo "Closing Zed screenshot window via close button..."
osascript -e '
tell application "System Events"
    tell process "zed"
        click button 1 of front window
    end tell
end tell
' 2>/dev/null || true

if [ ! -f "$OUTPUT_PATH" ]; then
    echo "ERROR: Screenshot file was not created" >&2
    exit 1
fi

FILE_SIZE=$(stat -f%z "$OUTPUT_PATH")
echo "Screenshot saved: $OUTPUT_PATH (${FILE_SIZE} bytes)"

if [ "$FILE_SIZE" -lt "$MIN_SIZE" ]; then
    echo "WARNING: File size ${FILE_SIZE} bytes is below ${MIN_SIZE} byte threshold — screenshot may be broken" >&2
    exit 2
fi

echo "SUCCESS: Screenshot captured and validated"
