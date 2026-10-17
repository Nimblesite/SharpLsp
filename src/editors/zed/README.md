# SharpLsp in Zed

C# and F# code intelligence for [Zed](https://zed.dev).

## Install

1. Install the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) and [Rust](https://www.rust-lang.org/tools/install).
2. In Zed, open the Extensions page and install **C#** and **F#**.
3. Clone SharpLsp:

   ```sh
   git clone https://github.com/Nimblesite/SharpLsp.git
   ```

4. On the Extensions page, click **Install Dev Extension** and select the `src/editors/zed` folder in the clone.
5. Open your .NET project folder, and trust it when Zed asks.

SharpLsp downloads its server the first time you open a C# or F# file.

## Use SharpLsp instead of the other C# and F# servers

Add this to your Zed settings (`zed: open settings file`):

```json
{
  "languages": {
    "CSharp": { "language_servers": ["sharplsp", "!omnisharp", "!roslyn", "!csharp-ls", "..."] },
    "FSharp": { "language_servers": ["sharplsp", "!fsautocomplete", "..."] }
  }
}
```

If SharpLsp doesn't start, run `zed: open log` to see why.
