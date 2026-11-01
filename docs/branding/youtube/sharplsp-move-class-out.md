# YouTube: Move a Class Out in VS Code

Video: `sharplsp-move-type.mp4` (1920x1080, 1:31), made by the TikTok factory reel
`projects/sharplsp/videos/move-type`.

## Title

```text
Move a Nested Class Out of Its Parent in VS Code (C# Refactoring Visual Studio Doesn't Have)
```

## Description

YouTube rejects angle brackets, so the description has none.

```text
Install SharpLsp from the VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=Nimblesite.sharplsp#review-details
Subscribe for .NET, C# and F# content: https://www.youtube.com/@SharpLspDev

Visual Studio can move a class to its own file. SharpLsp does that in VS Code, and then goes further: it moves a NESTED class out of its parent, fixes its accessibility, qualifies what it borrowed from the parent, and rewrites every caller in the solution. Every frame is the real VS Code running SharpLsp, free C# and F# tooling, on a real .NET project.

1. Move a type to its own file: Receipt shares Order's file; one code action gives it Receipt.cs with the same usings and namespace.
2. Move a private nested type out: LineItem is a private record inside Order. Moved out, private becomes internal and the helper it borrowed is written as Order.Round, so it still compiles.
3. Callers follow: Status is public and Program.cs refers to it as Order.Status. Move it out and every reference in the solution drops the Order prefix.
4. Withheld where it would not compile: Totals calls a private method of Order. The move is simply not offered, and a move that would still break the build fails with the compiler's reason instead of applying.

Chapters
0:00 Move a class out
0:15 Move a type to its own file
0:31 Move a private nested type out
0:47 Callers follow
1:04 Withheld where it would not compile
1:18 Recap

Install SharpLsp: https://marketplace.visualstudio.com/items?itemName=Nimblesite.sharplsp#review-details
Subscribe for .NET, C# and F# content: https://www.youtube.com/@SharpLspDev
Open VSX (VSCodium, Cursor, Windsurf): https://open-vsx.org/extension/nimblesite/sharplsp
Docs: https://sharplsp.dev
Source: https://github.com/Nimblesite/SharpLsp

#csharp #dotnet #vscode
```

## Tags

```text
C# refactoring, move class to file, move type to file, nested class, inner class, move nested class, C# nested class, VS Code C#, C# VS Code, VS Code refactoring, Visual Studio refactoring, C#, csharp, dotnet, .NET, SharpLsp, Roslyn, language server, code actions
```
