---
layout: layouts/docs.njk
title: Tutorial
description: "The SharpLsp interactive tutorial in VS Code: a film for each step, F# first then C#, and each step ticks itself off when SharpLsp answers your hover, completion, F12 or code action."
---

# The SharpLsp Tutorial

SharpLsp teaches itself inside VS Code. The tutorial plays a short film for each step while you carry out that step in your own editor, on your own code. When SharpLsp answers the action, the step ticks itself off and the next film starts. There is no "Mark done" button: a hover that returns nothing does not count.

F# comes first, then C#. Each language has the same seven steps.

{% video "vscode-tutorial" %}

## Open the Tutorial

- **First run.** The first time SharpLsp starts, it opens the F# walkthrough on VS Code's Get Started page, with the tutorial panel beside it.
- **Any time.** Run **SharpLsp: Open Tutorial** from the Command Palette (Cmd+Shift+P, or Ctrl+Shift+P on Windows and Linux).
- **Get Started page.** Open **Help → Welcome**, then pick **Learn SharpLsp with F#** or **Learn SharpLsp with C#**.

The panel has an F# and a C# switch, the language's seven steps and the current step's film. **Open one for me** opens a source file from your loaded solution, so every later step has something to answer.

## The Steps

Each step in the film, F# first. Select a time to watch that step:

{% chapters "vscode-tutorial" %}

| Step | You | It ticks when |
|------|-----|---------------|
| Open a file | open an F# or C# source file | an editor of that language becomes active |
| Hover | rest the mouse on a function, type or value | SharpLsp returns Quick Info |
| Complete code | type a dot after a value, or press Ctrl+Space | SharpLsp returns at least one completion |
| Go to a definition | put the cursor on a symbol and press F12 | SharpLsp finds the definition |
| Find all references | put the cursor on a symbol and press Shift+F12 | SharpLsp finds at least one reference |
| Fix code | press Cmd+. (Ctrl+. on Windows and Linux) on a warning or error | SharpLsp offers at least one code action |
| Solution Explorer | select the SharpLsp icon in the Activity Bar | the Solution Explorer opens (this ticks both languages) |

The panel plays the matching docs film for each step: [Hover](/docs/hover/), [Code Completions](/docs/completions/), [Go to Definition](/docs/go-to-definition/) and the [refactoring lesson](/docs/refactoring/).

## Settings

- `sharplsp.tutorial.showOnStartup` (default `true`): set it to `false` to stop the tutorial opening on first run.
- **SharpLsp: Reset Tutorial Progress** clears every tick, so you can take the tutorial again.

The tutorial also works in browser VS Code served from your own machine with `code serve-web`. vscode.dev and github.dev cannot run SharpLsp, because they have no local extension host.

<p class="next-link"><a href="/docs/editors/">Next: Editor Setup <span aria-hidden="true">→</span></a></p>
