namespace FSharpFixtures

open System

/// Geometry helpers operating on the Shape domain type.
module Geometry =

    /// Compute the area of a single shape.
    let area (shape: Shape) : float =
        match shape with
        | Circle radius -> Math.PI * radius * radius
        | Rectangle(width, height) -> width * height
        | Triangle(baseLen, height) -> 0.5 * baseLen * height

    /// Sum the areas of many shapes using a pipeline.
    let totalArea (shapes: Shape list) : float =
        shapes
        |> List.map area
        |> List.sum

    /// Active pattern classifying integers by parity.
    let (|Even|Odd|) (value: int) =
        if value % 2 = 0 then Even else Odd

    /// Describe an integer's parity via the active pattern.
    let describeParity (value: int) : string =
        match value with
        | Even -> "even"
        | Odd -> "odd"

/// A configurable greeter. Class type with a member.
type Greeter(greeting: string) =
    /// Greet the given name with the configured greeting.
    member _.Greet(name: string) : string =
        sprintf "%s, %s!" greeting name

/// A dog that implements IAnimal. Object expression / interface impl.
type Dog(dogName: string) =
    interface IAnimal with
        member _.Speak() = "Woof"
        member _.Name = dogName
