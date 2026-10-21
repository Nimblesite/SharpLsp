namespace Domain

/// A player on the leader board.
type Player =
    { /// The player's display name.
      Name: string
      /// The points the player has scored.
      Score: int }

/// Where a player stands against the field.
type Standing =
    /// No player has scored more.
    | Leading
    /// Behind the leader by some points.
    | Chasing of gap: int

/// Scoring rules for the leader board.
module Scoring =
    /// The sum of every player's score.
    let total (players: seq<Player>) = players |> Seq.sumBy (fun player -> player.Score)

    /// Where `player` stands against `field`.
    let standing (field: seq<Player>) (player: Player) =
        let best = field |> Seq.map (fun other -> other.Score) |> Seq.max
        if player.Score = best then Leading else Chasing(best - player.Score)
