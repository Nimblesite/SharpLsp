module FsStorefront.Sessions

open System.Collections.Generic

// Remembers every order "for analytics", and never forgets one.
let private sessions = Dictionary<int, CustomerSession>()

let remember order =
    let stage = CheckedOut order.Total
    sessions[order.Id] <- { Order = order; Stage = stage; Snapshot = Array.zeroCreate 4096 }
