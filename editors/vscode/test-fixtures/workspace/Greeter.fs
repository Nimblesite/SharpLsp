namespace TestFixtures

module Greeter =

    type Language =
        | English
        | Spanish
        | French

    let greet (name: string) (lang: Language) =
        match lang with
        | English -> sprintf "Hello, %s!" name
        | Spanish -> sprintf "Hola, %s!" name
        | French -> sprintf "Bonjour, %s!" name

    let greetAll (names: string list) (lang: Language) =
        names |> List.map (fun name -> greet name lang)

    type Greeter(defaultLang: Language) =
        member _.Greet(name: string) =
            greet name defaultLang

        member _.GreetAll(names: string list) =
            greetAll names defaultLang
