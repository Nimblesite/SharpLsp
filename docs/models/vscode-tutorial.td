typeDiagram

# The interactive tutorial's model ([TUTORIAL-MODEL]). The extension's
# src/tutorial/model.generated.ts is generated from this file by
# tools/vsix/tutorial-model.mjs; never edit that file by hand.

# A language the tutorial teaches. F# is taught first.
union TutorialLanguage {
  FSharp
  CSharp
}

# One thing the user does in the live editor.
union TutorialAction {
  # Open a source file of the language in an editor.
  OpenFile
  # Hover a symbol, and SharpLsp answers with Quick Info.
  Hover
  # Trigger completion, and SharpLsp answers with items.
  Completion
  # Go to a symbol's definition, and SharpLsp answers with a location.
  Definition
  # Find all references, and SharpLsp answers with locations.
  References
  # Invoke code actions (Cmd+. / Ctrl+.), and SharpLsp answers with fixes and refactorings.
  CodeAction
  # Show the Solution Explorer.
  SolutionExplorer
}

# A step of one language's walkthrough.
type TutorialStep {
  language: TutorialLanguage
  action: TutorialAction
}

# Every step the user has carried out, persisted across sessions.
type TutorialProgress {
  done: List<TutorialStep>
}
