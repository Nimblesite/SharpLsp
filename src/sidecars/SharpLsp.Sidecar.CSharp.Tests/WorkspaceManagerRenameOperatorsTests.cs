using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // File IO is banned for analyzers — these are tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// [RENAME-COVERAGE] Operators and conversion operators rename across a real two-file project:
/// every overloadable spelling of the same shape, compound assignments and both unary positions
/// included, with the compiler refusing a respelling that would not compile. [RENAME-ERRORS]
/// </summary>
public sealed class WorkspaceManagerRenameOperatorsTests : IAsyncLifetime, IDisposable
{
    private const string Declarations = """
        namespace Ops;

        public readonly struct Money
        {
            public Money(int cents) => Cents = cents;
            public int Cents { get; }
            public static Money operator +(Money a, Money b) => new(a.Cents + b.Cents);
            public static Money operator -(Money a) => new(-a.Cents);
            public static Money operator ++(Money a) => new(a.Cents + 1);
            public static bool operator <(Money a, Money b) => a.Cents < b.Cents;
            public static bool operator >(Money a, Money b) => a.Cents > b.Cents;
            public static implicit operator int(Money value) => value.Cents;
            public static explicit operator Money(int cents) => new(cents);
        }

        """;

    private const string Uses = """
        namespace Ops;

        public static class Uses
        {
            public static Money Sum(Money a, Money b) => a + b;
            public static Money Grow(Money a, Money b) { a += b; return a; }
            public static Money Negate(Money a) => -a;
            public static Money Next(Money a) { a++; ++a; return a; }
            public static bool Less(Money a, Money b) => a < b;
            public static int Cents(Money a) => a;
            public static int Doubled(Money a) { int cents = a; return cents * 2; }
            public static Money Wrap(int cents) => (Money)cents;
        }

        """;

    private readonly string _root = NativePaths.Temp($"sharplsp-rename-ops-{Guid.NewGuid():N}");
    private readonly WorkspaceManager _manager = new();
    private string DeclarationsPath => NativePaths.Join(_root, "Money.cs");
    private string UsesPath => NativePaths.Join(_root, "Uses.cs");

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_root);
        var project = NativePaths.Join(_root, "Ops.csproj");
        await File.WriteAllTextAsync(
                project,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Library</OutputType></PropertyGroup></Project>"
            )
            .ConfigureAwait(false);
        await File.WriteAllTextAsync(DeclarationsPath, Declarations).ConfigureAwait(false);
        await File.WriteAllTextAsync(UsesPath, Uses).ConfigureAwait(false);
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var opened = await _manager.OpenAsync(project).ConfigureAwait(false);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _manager.Dispose();
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, true);
        }
    }

    /// <summary>The position of <paramref name="token"/> inside its first <paramref name="marker"/>.</summary>
    private static LinePosition At(string source, string marker, string token)
    {
        var offset =
            source.IndexOf(marker, StringComparison.Ordinal)
            + marker.IndexOf(token, StringComparison.Ordinal);
        return SourceText.From(source).Lines.GetLinePosition(offset);
    }

    /// <summary>Rename at a position and return each file's text with its edits applied.</summary>
    private async Task<(string Declarations, string Uses, int Edits)> RenameAsync(
        string path,
        LinePosition at,
        string newName
    )
    {
        var result = await _manager
            .RenameAsync(path, at.Line, at.Character, newName)
            .ConfigureAwait(false);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var changes = (+result).DocumentChanges;
        string Applied(string file, string source)
        {
            var edits = changes.Where(change => NativePaths.AreEqual(change.FilePath, file));
            return TextEditing.ApplyEdits(source, edits.SelectMany(change => change.Edits));
        }
        return (
            Applied(DeclarationsPath, Declarations),
            Applied(UsesPath, Uses),
            changes.Sum(change => change.Edits.Count)
        );
    }

    private async Task<string> RefusalAsync(string path, LinePosition at, string newName)
    {
        var result = await _manager
            .RenameAsync(path, at.Line, at.Character, newName)
            .ConfigureAwait(false);
        Assert.True(result.IsError, $"renaming to {newName} must be refused");
        return result.Match(_ => "", error => error);
    }

    private async Task AssertPreparesAsync(string path, LinePosition at, string placeholder)
    {
        var prepared = await _manager
            .PrepareRenameAsync(path, at.Line, at.Character)
            .ConfigureAwait(false);
        Assert.False(prepared.IsError, prepared.Match(_ => "ok", error => error));
        Assert.True((+prepared).CanRename, $"{placeholder} must be renameable");
        Assert.Equal(placeholder, (+prepared).Placeholder);
        Assert.Equal(at.Line, (+prepared).StartLine);
        Assert.Equal(at.Character, (+prepared).StartCharacter);
        Assert.Equal(at.Character + placeholder.Length, (+prepared).EndCharacter);
    }

    [Fact]
    public async Task Binary_operator_respells_its_declaration_uses_and_compound_assignments()
    {
        var declared = At(Declarations, "operator +(Money", "+");
        await AssertPreparesAsync(DeclarationsPath, declared, "+");

        var (declarations, uses, edits) = await RenameAsync(DeclarationsPath, declared, "*");
        Assert.Equal(3, edits);
        Assert.Equal(Declarations.Replace("operator +(Money", "operator *(Money"), declarations);
        Assert.Equal(Uses.Replace("=> a + b;", "=> a * b;").Replace("a += b;", "a *= b;"), uses);

        // From a use, and from the compound assignment, the same rename results.
        var used = At(Uses, "=> a + b;", "+");
        await AssertPreparesAsync(UsesPath, used, "+");
        Assert.Equal((declarations, uses, 3), await RenameAsync(UsesPath, used, "*"));
        var compound = At(Uses, "a += b;", "+=");
        Assert.Equal((declarations, uses, 3), await RenameAsync(UsesPath, compound, "*"));

        // The same spelling changes nothing.
        Assert.Equal((Declarations, Uses, 0), await RenameAsync(DeclarationsPath, declared, "+"));
    }

    [Fact]
    public async Task Unary_operators_respell_prefix_and_postfix_uses()
    {
        var negate = At(Declarations, "operator -(Money a)", "-");
        await AssertPreparesAsync(DeclarationsPath, negate, "-");
        var (declarations, uses, edits) = await RenameAsync(DeclarationsPath, negate, "~");
        Assert.Equal(2, edits);
        Assert.Equal(
            Declarations.Replace("operator -(Money a)", "operator ~(Money a)"),
            declarations
        );
        Assert.Equal(Uses.Replace("=> -a;", "=> ~a;"), uses);

        var increment = At(Uses, "a++;", "++");
        await AssertPreparesAsync(UsesPath, increment, "++");
        var (decremented, decrementedUses, count) = await RenameAsync(UsesPath, increment, "--");
        Assert.Equal(3, count);
        Assert.Equal(
            Declarations.Replace("operator ++(Money a)", "operator --(Money a)"),
            decremented
        );
        Assert.Equal(Uses.Replace("a++; ++a;", "a--; --a;"), decrementedUses);
    }

    [Fact]
    public async Task A_respelling_the_compiler_rejects_is_refused_with_its_error()
    {
        var plus = At(Declarations, "operator +(Money", "+");
        // `==` must return bool and needs `!=`: the compiler says so.
        Assert.Contains(
            "Invalid C# operator rename: CS",
            await RefusalAsync(DeclarationsPath, plus, "==")
        );
        // `<` leaves `>` without its pair; as `+` it would duplicate the existing signature.
        var less = At(Declarations, "operator <(Money", "<");
        Assert.Contains("CS0216", await RefusalAsync(DeclarationsPath, less, "-"));
        Assert.Contains("CS0111", await RefusalAsync(DeclarationsPath, less, "+"));
        // A unary operator cannot take a binary-only spelling, nor a word.
        var negate = At(Declarations, "operator -(Money a)", "-");
        Assert.Equal(
            "Invalid C# operator rename",
            await RefusalAsync(DeclarationsPath, negate, "*")
        );
        Assert.Equal(
            "Invalid C# operator rename",
            await RefusalAsync(DeclarationsPath, plus, "plus")
        );
        Assert.Equal("Invalid C# operator rename", await RefusalAsync(DeclarationsPath, plus, "!"));

        // A built-in operator is nobody's to rename.
        var builtIn = At(Declarations, "a.Cents + b.Cents", "+");
        var prepared = await _manager.PrepareRenameAsync(
            DeclarationsPath,
            builtIn.Line,
            builtIn.Character
        );
        Assert.False(prepared.IsError, prepared.Match(_ => "ok", error => error));
        Assert.False((+prepared).CanRename);
    }

    [Fact]
    public async Task Conversion_operators_turn_explicit_with_casts_and_implicit_without()
    {
        var keyword = At(Declarations, "implicit operator int", "implicit");
        await AssertPreparesAsync(DeclarationsPath, keyword, "implicit");
        var (declarations, uses, edits) = await RenameAsync(DeclarationsPath, keyword, "explicit");
        Assert.Equal(3, edits);
        Assert.Equal(
            Declarations.Replace("implicit operator int", "explicit operator int"),
            declarations
        );
        Assert.Equal(
            Uses.Replace("Cents(Money a) => a;", "Cents(Money a) => (int)(a);")
                .Replace("int cents = a;", "int cents = (int)(a);"),
            uses
        );

        // Turning an explicit conversion implicit keeps every cast: only the keyword changes.
        var explicitKeyword = At(Declarations, "explicit operator Money", "explicit");
        await AssertPreparesAsync(DeclarationsPath, explicitKeyword, "explicit");
        var (relaxed, relaxedUses, count) = await RenameAsync(
            DeclarationsPath,
            explicitKeyword,
            "implicit"
        );
        Assert.Equal(1, count);
        Assert.Equal(
            Declarations.Replace("explicit operator Money", "implicit operator Money"),
            relaxed
        );
        Assert.Equal(Uses, relaxedUses);

        Assert.Equal(
            "Invalid C# operator rename",
            await RefusalAsync(DeclarationsPath, keyword, "widening")
        );
        Assert.Equal(
            (Declarations, Uses, 0),
            await RenameAsync(DeclarationsPath, keyword, "implicit")
        );
    }
}
