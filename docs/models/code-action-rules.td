typeDiagram

# Fix-all scopes and associated-rule enforcement ([FIXALL-MODEL]).
# The C# sidecar, F# sidecar and Rust host types are generated from this file;
# never hand-write them. The associated-rule table ([FIXALL-RULES-TABLE]) is data
# conforming to AssociatedRule, generated into each tier.

# How far one fix is applied.
union FixScope {
  # The single occurrence under the cursor (today's only behaviour).
  Occurrence
  # Every occurrence in the containing member.
  ContainingMember
  # Every occurrence in the containing type.
  ContainingType
  # Every occurrence in the document.
  Document
  # Every occurrence in the owning project.
  Project
  # Every occurrence in every project of the loaded solution.
  Solution
}

# The language a rule belongs to. F# is listed first.
union RuleLanguage {
  FSharp
  CSharp
}

# Where a rule's enforcement is written.
union RuleSink {
  # A key/value under the matching [*.cs] / [*.fs] section of .editorconfig.
  EditorConfig
  # A [diagnostics] entry in the shared SharpLsp TOML (CONFIGURATION-SPEC).
  SharpLspToml
  # An MSBuild property in Directory.Build.props (e.g. EnforceCodeStyleInBuild).
  MsBuildProperty
}

# Severity written when a rule is enforced.
union RuleSeverity {
  Error
  Warning
  Suggestion
  Silent
  None
}

# One setting that makes a rule enforce the fixed style.
type RuleSetting {
  sink: RuleSink
  key: String
  value: String
}

# A rule associated with a fix. Enforcing it makes the fixed style mandatory.
type AssociatedRule {
  # Diagnostic id that reports violations (IDE0007, SLSPF0102, FS1182 ...).
  diagnosticId: String
  language: RuleLanguage
  title: String
  # Option settings that select the style the fix produces.
  settings: List<RuleSetting>
  # Severity written for diagnosticId when enforced.
  severity: RuleSeverity
}

# The fix (code-fix equivalence key or refactoring id) and every rule it maps to.
type FixRuleAssociation {
  # Stable fix identity: CodeAction.EquivalenceKey (C#) or SharpLsp fix id (F#).
  fixKey: String
  language: RuleLanguage
  rules: List<AssociatedRule>
}

# What the user asked for when picking a fix-all action.
type FixAllRequest {
  fixKey: String
  scope: FixScope
  # true => also write every associated rule's settings ("Fix all and enforce").
  enforce: Bool
}
