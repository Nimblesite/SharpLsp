// Obsolete uses strike through; unused and unreachable code greys out. [DIAG-CATEGORIES-TAGS]
module FsTags.Tagged

open System.Text

[<System.Obsolete("Use fresh")>]
let stale () = 1

let fresh () = stale ()

let describe (n: int) =
    match n with
    | _ -> "any"
    | 1 -> "one"

let private unused () = 2
