---
layout: layouts/docs.njk
title: Refactoring & Code Actions
eleventyNavigation:
  key: Refactoring & Code Actions
  order: 7
---

![Code actions lightbulb in VS Code](/assets/screenshots/vscode-refactoring.png)

*Roslyn-powered code actions and refactorings — the same engine as Visual Studio.*

# Refactoring & Code Actions

Forge exposes the full Roslyn code action pipeline. When the cursor is on a symbol, a diagnostic, or a selection, VS Code shows a lightbulb (💡) offering quick fixes and refactorings sourced directly from Roslyn.

## Triggering Code Actions

- **Lightbulb**: click the 💡 icon that appears in the editor gutter
- **Keyboard**: `Ctrl+.` (Windows/Linux) or `Cmd+.` (macOS)
- **Quick Fix**: position the cursor on a diagnostic squiggle and press the shortcut above

## Available Actions

Forge exposes every code action Roslyn provides, including:

| Category | Examples |
|----------|---------|
| Quick fixes | Add missing `using`, implement interface, add null check |
| Refactorings | Rename, extract method, extract variable, inline variable |
| Style | Convert to expression body, add/remove braces, use pattern matching |
| Generate | Generate constructor, generate property, generate override |

## Performance Targets

| Metric | Target |
|--------|--------|
| Code action list | <200ms p50 |
| Apply fix | <100ms |
