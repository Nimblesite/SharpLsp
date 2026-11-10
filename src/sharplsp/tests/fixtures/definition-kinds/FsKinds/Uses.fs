// Uses of every kind in Kinds.fs, from another file. [DEFINITION-FSHARP]
module FsKinds.Uses

open FsKinds.Kinds

let origin: Point = { X = 0; Y = 0 }
let shape = Circle 1.0
let label = parity origin.X
let size = shape
let pet: Animal = Dog()
let says = pet.Speak()
let odd = match 3 with Even -> false | Odd -> true
let radius = match shape with Circle r -> r | Square s -> s
