// Every F# declaration kind go-to-definition must land on. [DEFINITION-FSHARP]
module FsKinds.Kinds

type Point = { X: int; Y: int }

type Shape =
    | Circle of radius: float
    | Square of side: float

let (|Even|Odd|) (n: int) = if n % 2 = 0 then Even else Odd

let parity (n: int) =
    match n with
    | Even -> "even"
    | Odd -> "odd"

[<AbstractClass>]
type Animal() =
    abstract Speak: unit -> string

type Dog() =
    inherit Animal()
    override _.Speak() = "woof"

type Cat() =
    inherit Animal()
    override _.Speak() = "meow"

let describe (p: Point) = parity p.X
