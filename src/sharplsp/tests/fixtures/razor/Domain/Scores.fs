namespace Domain

/// A player on the leader board.
type Player = { Name: string; Score: int }

/// Scoring rules for the leader board.
module Scoring =
    /// The sum of every player's score.
    let total (players: seq<Player>) = players |> Seq.sumBy (fun player -> player.Score)
