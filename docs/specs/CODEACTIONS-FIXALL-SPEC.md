# Fix All and Associated Rules Specification `[FIXALL]`

Plan: [CODEACTIONS-FIXALL-PLAN](../plans/CODEACTIONS-FIXALL-PLAN.md). Model:
[code-action-rules.td](../models/code-action-rules.td). Bug: GitHub #577.

## [FIXALL-GOAL] Goal

Today every quick fix and refactoring applies to **one occurrence**. A user who picks
"Use implicit type" must repeat it at every explicit type in the codebase, and nothing
stops the next explicit type from being written.

SharpLsp must let the user, in one action:

1. **Fix all** occurrences of a fix in a document, project or the whole solution.
2. **Enforce** the rule(s) associated with that fix, so the fixed style becomes mandatory
   (e.g. every explicit type converted to `var`, then explicit types become a build error).

F# gets this first ([AGENTS Aim #2]); C# follows on the same pipeline.

## [FIXALL-MODEL] Model

Declared in typeDiagram ([code-action-rules.td](../models/code-action-rules.td)); the C#,
F# and Rust types are generated from it. Key types: `FixScope`, `AssociatedRule`,
`RuleSetting`, `RuleSink`, `FixRuleAssociation`, `FixAllRequest`.

## [FIXALL-SCOPES] Scopes

| Scope | Meaning | C# engine | F# engine |
|---|---|---|---|
| `Occurrence` | Today's single fix | `CodeAction` | SharpLsp fix |
| `ContainingMember` / `ContainingType` | Member / type around the cursor | `FixAllScope.ContainingMember/Type` | AST range of the enclosing binding / type |
| `Document` | Whole file | `FixAllScope.Document` | Fix applied to every finding in the file |
| `Project` | Owning project | `FixAllScope.Project` | Every file of the owning `FSharpProjectOptions` |
| `Solution` | Every loaded project | `FixAllScope.Solution` | Every F# project in the loaded solution |

- **C#.** A fix is fix-all capable when its `CodeFixProvider.GetFixAllProvider()` is
  non-null and supports the scope (`GetSupportedFixAllScopes`). Refactorings use Roslyn's
  refactor-all support where the provider exposes it. Occurrences are found with the
  diagnostic id and the action's `EquivalenceKey`, never by title text.
- **F#.** Every SharpLsp F# fix (remove unused open, simplify name, remove unused
  declaration, `_` prefix, add `new`, …) exposes a batch form: compute all findings for the
  scope with the same query the diagnostics use, compute every edit from the AST, and merge
  them per file. Overlapping edits are dropped from the batch and reported, never merged by
  text.
- Only scopes the engine supports are offered.

## [FIXALL-LSP] LSP Surface (editor-agnostic)

For each fix-all-capable action in a `textDocument/codeAction` response, the server adds
**one** extra action, `Fix all: <title>…`, kind `quickfix` (or `refactor.rewrite`),
carrying the `FixAllRequest` key in `data`. It does not add one action per scope; the menu
in the bug screenshot is already long.

Resolving it runs the command `sharplsp.fixAll`:

1. **Scope.** The host asks with `window/showMessageRequest` (Document / Project /
   Solution, supported scopes only). VS Code replaces this with a QuickPick
   ([FIXALL-VSCODE]).
2. **Enforce.** When the fix has associated rules ([FIXALL-RULES]), the host asks
   "Also enforce <rule ids>?" — options `Fix only`, `Fix and enforce`.
3. **Compute.** The sidecar computes the edit under `$/progress` (cancellable,
   files-done/total). A cancelled computation applies nothing.
4. **Apply.** The host sends one `workspace/applyEdit`. A `Project` or `Solution` edit
   carries a `ChangeAnnotation` with `needsConfirmation: true`, so clients that support it
   show a preview. The rule edits ([FIXALL-ENFORCE]) are a separate annotation in the
   same edit, so a user can untick them in the preview.
5. **Verify.** After the edit is applied, the host re-pulls diagnostics for the scope and
   reports `Fixed N occurrences in M files; K remain` with the rule id. `K > 0` (a provider
   could not fix some sites) is reported as a warning listing the first locations, never
   silently ([REFACTOR-NEVER-SILENT]).

`source.fixAll.sharplsp` is also registered for `codeActionsOnSave`: document scope, fixes
only for rules already enforced in `.editorconfig`/TOML, never writes rules.

## [FIXALL-RULES] Associated Rules

An **associated rule** is a diagnostic rule whose enforcement makes the fixed style
mandatory. A fix maps to **zero, one or many** rules ([FIXALL-RULES-TABLE]). Example:
"Use implicit type" maps to IDE0007 plus three style options (built-in types, apparent
types, elsewhere) and must turn **off** the opposing IDE0008.

- **Opposing rules.** A rule that demands the opposite style (IDE0007 ↔ IDE0008,
  IDE0160 ↔ IDE0161) is written as `none` when its opposite is enforced, otherwise the
  codebase can never be clean.
- **No rule.** Fixes without a rule (e.g. "Inline temporary variable") offer fix-all only.
- **Table is data.** The table below is the source; it is generated into each tier from
  the model. Roslyn's internal id↔option mapping is not used (internal API) and nothing is
  copied from Visual Studio, Rider or C# Dev Kit; entries come from the public
  [code-style rule docs](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/).
- **Enforce without fixing** is never offered alone from a fix: enforcing a rule that
  still has violations breaks the build. A standalone "Enforce rule" command exists only
  when the scope's violation count is zero.

### [FIXALL-RULES-TABLE] Associated Rule Table

F# first.

| Lang | Fix | Rule(s) enforced | Settings written | Opposing rule set to `none` |
|---|---|---|---|---|
| F# | Remove unused open | SLSPF0102 | `dotnet_diagnostic.SLSPF0102.severity = error` | — |
| F# | Simplify name | SLSPF0103 | `dotnet_diagnostic.SLSPF0103.severity = error` | — |
| F# | Remove unused declaration | SLSPF0101 | `dotnet_diagnostic.SLSPF0101.severity = error`; TOML `[diagnostics] dead_code = true` | — |
| F# | Prefix unused value with `_` | FS1182 | MSBuild `OtherFlags += --warnon:1182`, `WarningsAsErrors += FS1182` | — |
| F# | Add `new` for IDisposable | FS0760 | MSBuild `WarningsAsErrors += FS0760` | — |
| F# | Format document (Fantomas) | Fantomas check | TOML `[formatting] check_on_build = true` | — |
| C# | Use implicit type (`var`) | IDE0007 | `csharp_style_var_for_built_in_types`, `csharp_style_var_when_type_is_apparent`, `csharp_style_var_elsewhere = true` | IDE0008 |
| C# | Use explicit type | IDE0008 | the same three options `= false` | IDE0007 |
| C# | Convert to file-scoped namespace | IDE0161 | `csharp_style_namespace_declarations = file_scoped` | IDE0160 |
| C# | Convert to block-scoped namespace | IDE0160 | `csharp_style_namespace_declarations = block_scoped` | IDE0161 |
| C# | Remove unnecessary usings | IDE0005 | severity only; MSBuild `GenerateDocumentationFile = true` (required for build enforcement) | — |
| C# | Use expression body (method/property/ctor/…) | IDE0022, IDE0025, IDE0021, … | `csharp_style_expression_bodied_* = true` | IDE0022 block-body direction |
| C# | Add braces | IDE0011 | `csharp_prefer_braces = true` | — |
| C# | Use collection expression | IDE0028, IDE0300–IDE0305 | `dotnet_style_prefer_collection_expression = true` | — |
| C# | Use primary constructor | IDE0290 | `csharp_style_prefer_primary_constructors = true` | — |
| C# | Use pattern matching | IDE0019, IDE0020, IDE0038, IDE0078 | `csharp_style_pattern_matching_over_as_with_null_check`, `csharp_style_pattern_matching_over_is_with_cast_check`, `csharp_style_prefer_pattern_matching = true` | — |
| C# | Use switch expression | IDE0066 | `csharp_style_prefer_switch_expression = true` | — |
| C# | Make field readonly | IDE0044 | `dotnet_style_readonly_field = true` | — |
| C# | Remove `this.` qualification | IDE0003 | `dotnet_style_qualification_for_{field,property,method,event} = false` | IDE0009 |
| C# | Simplify name / member access | IDE0001, IDE0002 | severity only | — |
| C# | Remove unnecessary cast | IDE0004 | severity only | — |
| C# | Use null propagation / coalesce | IDE0031, IDE0029, IDE0030 | `dotnet_style_null_propagation`, `dotnet_style_coalesce_expression = true` | — |
| C# | Remove unused value assignment | IDE0059 | `csharp_style_unused_value_assignment_preference = discard_variable` | — |
| C# | Inline temporary variable | — | — (fix-all only) | — |

Every row also writes `dotnet_diagnostic.<ID>.severity = error` (the default enforce
severity; the user may pick `warning`) and, for C# IDE rules, MSBuild
`EnforceCodeStyleInBuild = true` so the rule fails `dotnet build`, not only the editor.

## [FIXALL-ENFORCE] Writing Enforcement

- **`.editorconfig`.** The host owns a lossless `.editorconfig` CST (new module beside the
  TOML config). Writes go through it: comments, ordering and unrelated keys survive. Never
  regex, line splicing or string concatenation.
  - Target file: the nearest `.editorconfig` with `root = true` at or above the solution
    directory; if none, create `<solution dir>/.editorconfig` with `root = true`.
  - Section: `[*.cs]` for C#, `[*.{fs,fsi,fsx}]` for F#; created if missing. An existing key
    is updated in place.
  - A nested `.editorconfig` or more specific section that overrides the key for files in
    scope is reported and offered as part of the same edit, so the rule really applies.
- **MSBuild properties** go into `Directory.Build.props` at the solution directory
  (created if missing) through an XML DOM, merging list properties (`WarningsAsErrors`)
  rather than replacing them.
- **SharpLsp TOML** entries go through the existing TOML serializer
  ([CONFIGURATION-SPEC]).
- All three are text edits in the same `WorkspaceEdit` as the fix, under their own change
  annotation ("Enforce IDE0007"). Undo reverts everything.
- After apply, the sidecars reload analyzer config (`AnalyzerConfigDocument` change for
  C#, config reload for F#) and the host sends `workspace/diagnostic/refresh`, so a newly
  written explicit type is flagged immediately.

## [FIXALL-VSCODE] VS Code

- `sharplsp.fixAll` shows one QuickPick: scopes (Document / Project / Solution) and, below
  a separator, multi-select checkboxes for each associated rule with its severity (default
  ticked: the fix's own rule, opposing rules shown as "will be turned off").
- Progress uses `window.withProgress` (cancellable) bound to the server's `$/progress`.
- State is held in Signals ([VSCODE-REACTIVITY-SPEC]); the result message has
  `Show Changes` and `Open .editorconfig` buttons.
- A **Code Style Rules** view lists the associated-rule table for the loaded solution:
  rule id, current severity, violation count, and per-row `Fix all` / `Fix all and enforce`.
  Counts update reactively as diagnostics change.

## [FIXALL-PERFORMANCE] Performance

- Listing: the extra `Fix all…` action costs only a provider capability check; no
  occurrence search on `textDocument/codeAction`.
- Compute: solution scope runs per project in parallel, bounded by the sidecar's
  concurrency limit; target 10k occurrences across 200 files < 10 s.
- Edits are streamed into one `WorkspaceEdit`; no per-file `applyEdit` round-trips.

## [FIXALL-TESTS] Tests

E2E against real `.sln`/`.csproj`/`.fsproj` fixtures (no mocks), many interactions per
test:

- F# solution with two projects: fix-all unused opens at each scope; assert per-scope file
  counts, untouched files, FCS re-check clean, and SLSPF0102 written to `[*.{fs,fsi,fsx}]`;
  then add a new unused `open` and assert an **error** diagnostic.
- C# solution: "Use implicit type" fix-all solution + enforce; assert no explicit local
  types remain, `.editorconfig` has IDE0007 `error`, IDE0008 `none`, the three options,
  existing comments preserved, `EnforceCodeStyleInBuild` set; `dotnet build` fails on a
  newly added explicit type.
- Opposing direction (`var` → explicit) on the same fixture flips both rules.
- Cancellation mid-compute applies nothing; a partial-fix provider reports `K remain`.
- VS Code: QuickPick flow, preview confirmation, Undo restores code **and** config.
