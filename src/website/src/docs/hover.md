---
layout: layouts/docs.njk
title: Hover and Quick Info
eleventyExcludeFromCollections: true
---

![Hover in VS Code](/assets/screenshots/vscode-hover-page.png)

# Hover and Quick Info

Hover is implemented for both C# and F#. Requests are routed to Roslyn or FCS and are evaluated against the current unsaved document text.

## C# Hover

C# hover can include:

- the fully qualified symbol signature, modifiers, parameters, and nullable annotations;
- the containing type for members;
- an `[Obsolete]` message;
- rendered XML documentation;
- an inferred type for `var`, numeric literals, lambda parameters, tuple elements, and pattern variables.

String and character literals intentionally return no tooltip. Roslyn resolves both declarations and references, so hover works on definitions as well as uses.

## F# Hover

F# hover uses FCS enhanced tooltips. It returns a Markdown code block with the F# signature and renders available XML documentation. It supports functions, values, types, members, discriminated-union cases, and other FCS symbols.

## Live-Buffer Behavior

On open and change, SharpLsp sends the full document text to the matching sidecar. Hover therefore reflects edits that have not been saved to disk. Requests for superseded document versions do not replace newer navigation state.

## Failure Behavior

If no symbol exists at the position, a sidecar is disabled, or analysis fails, SharpLsp returns `null` rather than presenting invented information. Sidecar lifecycle monitoring can restart a failed sidecar, but the request that encountered the failure may still return no tooltip.
