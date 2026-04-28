---
layout: layouts/docs.njk
title: Refactoring & Code Actions
eleventyNavigation:
  key: Refactoring & Code Actions
  order: 7
---

![Code actions lightbulb in VS Code](/assets/screenshots/vscode-refactoring.png)

*Roslyn-powered code actions in the alpha VS Code extension.*

# Refactoring & Code Actions

Forge routes code actions through Roslyn. When the cursor is on a supported symbol, diagnostic, or selection, VS Code can show a lightbulb offering quick fixes and refactorings sourced from Roslyn.

## Triggering Code Actions

- **Lightbulb**: click the 💡 icon that appears in the editor gutter
- **Keyboard**: `Ctrl+.` (Windows/Linux) or `Cmd+.` (macOS)
- **Quick Fix**: position the cursor on a diagnostic squiggle and press the shortcut above

## Available Actions

Forge is building toward broad Roslyn code action coverage, including:

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
