using static SharpLsp.Sidecar.CSharp.Tests.RefactoringProject;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// End-to-end coverage for "Move 'Inner' out of 'Outer' to Inner.cs"
/// ([REFACTOR-MOVE-TYPE-OUT], [REFACTOR-MOVE-TYPE-REFUSED]). Every test drives the real
/// WorkspaceManager against a real MSBuild project, applies the action and asserts on
/// the files it produces: the new file, the container it left, and every consumer.
/// </summary>
public sealed class MoveTypeOutTests : IDisposable
{
    private const string Shapes = "Shapes.cs";
    private const string Consumers = "Consumers.cs";
    private const string Far = "Far.cs";
    private const string Existing = "Existing.cs";

    private static readonly IReadOnlyDictionary<string, string> Files = new Dictionary<
        string,
        string
    >(StringComparer.Ordinal)
    {
        [Shapes] = """
            using System;
            using System.Collections.Generic;

            namespace Geo;

            public class Outer
            {
                private static int Count;
                internal static int Helper() => 1;
                private static int Secret() => 2;

                /// <summary>A private nested type that borrows from its container.</summary>
                private class Inner
                {
                    public int Value => Helper() + Other.Size;
                    public List<int> Items { get; } = new();
                }

                internal class Other
                {
                    public const int Size = 3;
                }

                protected class Shielded { }

                public class Exposed { }

                public class Portal { }

                private class UsesSecret { public int V => Secret(); }

                private class UsesCount { public int V => Count; }

                private partial class Split { }
                private partial class Split { }

                private class Clash { }

                private Inner Make() => new Inner();
                private Outer.Inner MakeQualified() => new Outer.Inner();
            }

            public class Clash { }

            public class Generic<T>
            {
                private class UsesT { public T? Value; }
                private class Free { }
            }
            """,
        [Consumers] = """
            using System.Collections.Generic;
            using Geo;
            using Alias = Geo.Outer.Exposed;

            namespace App;

            public class Consumer : Outer
            {
                private Shielded? _shield;
                public Outer.Exposed Field = new Outer.Exposed();
                public global::Geo.Outer.Exposed Full = new();
                public System.Type Kind => typeof(Geo.Outer.Exposed);
                public string Name => nameof(Outer.Exposed);
                public List<Outer.Exposed> Many = new();
                public Alias? Aliased;
            }
            """,
        [Far] = """
            namespace Far;

            public class Sub : Geo.Outer { }

            public class UsesSub
            {
                public Far.Sub.Portal? Door;
            }
            """,
        [Existing] = """
            namespace Geo;

            public class Holder
            {
                private class Existing { }
            }
            """,
    };

    private readonly RefactoringProject _project = new("MoveOut", Files);

    public void Dispose()
    {
        _project.Dispose();
    }

    [Fact]
    public async Task A_private_nested_type_becomes_an_internal_top_level_type_in_its_own_file()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(
            manager,
            Shapes,
            "    private class Inner",
            "Inner",
            "Move 'Inner' out of 'Outer' to Inner.cs"
        );

        Assert.Equal(2, edit.DocumentChanges.Count);
        var created = edit.DocumentChanges.Single(change => change.Create);
        Assert.Equal(_project.PathOf("Inner.cs"), created.FilePath);

        var newFile = _project.After(edit, "Inner.cs");
        Assert.Contains("using System;", newFile);
        Assert.Contains("using System.Collections.Generic;", newFile);
        Assert.Contains("namespace Geo;", newFile);
        Assert.Contains(
            "/// <summary>A private nested type that borrows from its container.</summary>",
            newFile
        );
        Assert.Contains("internal class Inner", newFile);
        Assert.DoesNotContain("private class Inner", newFile);
        Assert.Contains("Outer.Helper() + Outer.Other.Size", newFile);
        Assert.Contains("public List<int> Items { get; } = new();", newFile);
        Assert.Empty(ParseErrors(newFile));

        var source = _project.After(edit, Shapes);
        Assert.DoesNotContain("class Inner", source);
        Assert.DoesNotContain("borrows from its container", source);
        Assert.Contains("internal class Other", source);
        Assert.Contains("private Inner Make() => new Inner();", source);
        Assert.Contains("private Inner MakeQualified() => new Inner();", source);
        Assert.Empty(ParseErrors(source));
    }

    [Fact]
    public async Task Every_qualified_reference_in_every_file_drops_the_container()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(
            manager,
            Shapes,
            "    public class Exposed { }",
            "Exposed",
            "Move 'Exposed' out of 'Outer' to Exposed.cs"
        );

        var consumers = _project.After(edit, Consumers);
        Assert.Contains("using Alias = Geo.Exposed;", consumers);
        Assert.Contains("public Exposed Field = new Exposed();", consumers);
        Assert.Contains("public global::Geo.Exposed Full = new();", consumers);
        Assert.Contains("typeof(Geo.Exposed)", consumers);
        Assert.Contains("nameof(Exposed)", consumers);
        Assert.Contains("List<Exposed> Many", consumers);
        Assert.DoesNotContain("Outer.Exposed", consumers);
        Assert.Empty(ParseErrors(consumers));

        var newFile = _project.After(edit, "Exposed.cs");
        Assert.Contains("public class Exposed { }", newFile);
        Assert.Equal(3, edit.DocumentChanges.Count);
    }

    [Fact]
    public async Task A_protected_nested_type_becomes_internal_and_a_derived_class_still_sees_it()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(
            manager,
            Shapes,
            "    protected class Shielded { }",
            "Shielded",
            "Move 'Shielded' out of 'Outer' to Shielded.cs"
        );

        Assert.Contains("internal class Shielded { }", _project.After(edit, "Shielded.cs"));
        // The derived class named it bare; nothing there needed to change.
        Assert.DoesNotContain(
            edit.DocumentChanges,
            change => NativePathsEqual(change.FilePath, _project.PathOf(Consumers))
        );
    }

    [Theory]
    // A private member of the container is unreachable from namespace level.
    [InlineData("    private class UsesSecret { public int V => Secret(); }", "UsesSecret")]
    [InlineData("    private class UsesCount { public int V => Count; }", "UsesCount")]
    // The other part would stay behind.
    [InlineData("    private partial class Split { }", "Split")]
    // Geo.Clash already exists; every shortened reference would bind to it.
    [InlineData("    private class Clash { }", "Clash")]
    // T means nothing at namespace level.
    [InlineData("    private class UsesT { public T? Value; }", "UsesT")]
    public async Task The_move_is_not_offered_where_it_cannot_be_done_mechanically(
        string anchor,
        string token
    )
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(manager, Shapes, anchor, token);

        Assert.DoesNotContain(
            actions,
            action =>
                action.Title.StartsWith("Move '", StringComparison.Ordinal)
                && action.Title.Contains(" out of ")
        );
    }

    [Fact]
    public async Task The_move_is_not_offered_when_the_new_file_already_exists()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(
            manager,
            Existing,
            "    private class Existing { }",
            "Existing"
        );

        Assert.DoesNotContain(actions, action => action.Title.Contains(" out of "));
    }

    [Fact]
    public async Task A_nested_type_of_a_generic_container_moves_when_it_does_not_use_the_type_parameter()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(
            manager,
            Shapes,
            "    private class Free { }",
            "Free"
        );

        Assert.Contains(
            actions,
            action => action.Title == "Move 'Free' out of 'Generic' to Free.cs"
        );
    }

    [Fact]
    public async Task A_top_level_type_has_nothing_to_move_out_of()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(manager, Shapes, "public class Outer", "Outer");

        Assert.DoesNotContain(actions, action => action.Title.Contains(" out of "));
    }

    [Fact]
    public async Task A_move_the_preconditions_let_through_fails_with_the_compile_error_instead_of_a_broken_edit()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(
            manager,
            Shapes,
            "    public class Portal { }",
            "Portal"
        );
        var action = actions.Find(item =>
            item.Title == "Move 'Portal' out of 'Outer' to Portal.cs"
        );
        Assert.NotNull(action);

        // Far.Sub.Portal would shorten to Far.Portal, which does not exist.
        var resolved = await manager.ResolveCodeActionAsync(action.Id);

        Assert.True(resolved.IsError);
        var reason = resolved.Match(_ => "", error => error);
        Assert.StartsWith(
            "Moving 'Portal' out of 'Outer' would not compile:",
            reason,
            StringComparison.Ordinal
        );
        Assert.Contains("Far.cs:", reason);
    }

    private static bool NativePathsEqual(string left, string right)
    {
        return Common.NativePaths.AreEqual(left, right);
    }
}
