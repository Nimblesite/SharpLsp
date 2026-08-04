module FSharpFixtures.RenameEdge

// Saved baseline intentionally differs from the live overlay. [RENAME-FSHARP-APPLY]
let savedName value = value + 1
let useSaved = savedName 2
let metadataValue = System.String.Empty
// savedName in a comment must remain unchanged.
let stringValue = "savedName"
