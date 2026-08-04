module FSharpFixtures.CodeFixes

// The System.Text namespace imported below is never used, so the unused-open
// analyzer (SLSPF0102) flags it and the "Remove unused open" code fix deletes it.
open System.Text

// The next import IS used (DateTime appears unqualified below), so it is never an
// unused-open candidate.
open System

/// Uses DateTime unqualified, which keeps the System import alive.
let nowKind () : DateTime = DateTime.Now

/// The System qualifier here is redundant given the import above; the
/// simplify-name analyzer (SLSPF0103) + "Simplify name" fix reduce it to DateTime.
let minimum = System.DateTime.MinValue
