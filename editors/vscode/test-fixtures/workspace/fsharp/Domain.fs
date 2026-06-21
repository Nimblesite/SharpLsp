namespace FSharpFixtures

/// A geometric shape. Discriminated union with named fields.
type Shape =
    | Circle of radius: float
    | Rectangle of width: float * height: float
    | Triangle of baseLen: float * height: float

/// A person with a name and an age. Record type.
type Person =
    { Name: string
      Age: int }

/// A generic labelled container. Generic record type.
type Container<'T> =
    { Label: string
      Value: 'T }

/// An animal that can speak. Interface type.
type IAnimal =
    /// The sound the animal makes.
    abstract member Speak: unit -> string
    /// The animal's given name.
    abstract member Name: string
