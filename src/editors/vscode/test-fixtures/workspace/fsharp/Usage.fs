namespace FSharpFixtures

/// Demonstrates cross-file usage of the Domain and Library modules.
/// Cursor positions here drive go-to-definition and find-references tests.
module Usage =

    /// A list mixing every Shape union case.
    let shapes : Shape list =
        [ Circle 1.0
          Rectangle(2.0, 3.0)
          Triangle(4.0, 5.0) ]

    /// Calls Geometry.totalArea (defined in Library.fs).
    let combinedArea : float = Geometry.totalArea shapes

    /// Constructs a Person record (defined in Domain.fs).
    let alice : Person = { Name = "Alice"; Age = 30 }

    /// Constructs a Greeter (defined in Library.fs).
    let greeter = Greeter("Hello")

    /// Reads the Person.Name field and calls Greeter.Greet.
    let aliceGreeting : string = greeter.Greet alice.Name

    /// Calls Geometry.describeParity (defined in Library.fs).
    let parity : string = Geometry.describeParity 7

    /// Local function reused below — find-references should see both call sites.
    let double (value: int) : int = value * 2

    /// Two call sites of `double` for reference counting.
    let quadruple (value: int) : int = double (double value)

    // Unannotated bindings — inlay hints must surface the inferred types here
    // (`: int`, `: string`, `: float`). Keep these without type annotations.
    let answer = double 21
    let label = "fsharp"
    let ratio = 3.14 * 2.0
