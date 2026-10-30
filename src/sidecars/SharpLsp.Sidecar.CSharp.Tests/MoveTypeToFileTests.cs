using static SharpLsp.Sidecar.CSharp.Tests.RefactoringProject;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// End-to-end coverage for Roslyn's "Move type to &lt;Name&gt;.cs"
/// ([REFACTOR-MOVE-TYPE-FILE]). Each applying test uses a real WorkspaceManager and
/// MSBuild project, then inspects and parses both sides of the resulting edit.
/// </summary>
public sealed class MoveTypeToFileTests : IDisposable
{
    private const string Many = "Many.cs";
    private const string Block = "Block.cs";
    private const string Global = "Global.cs";
    private const string Attributed = "Attributed.cs";
    private const string Generics = "Generics.cs";
    private const string Containers = "Containers.cs";
    private const string Matched = "AlreadyMatched.cs";
    private const string Spacing = "Spacing.cs";

    private static readonly IReadOnlyDictionary<string, string> Files = new Dictionary<string, string>(
        StringComparer.Ordinal
    )
    {
        [Many] = """
            using System;
            using System.Collections.Generic;

            namespace Shapes;

            public class Before
            {
                public List<int> Items { get; } = new();
            }

            /// <summary>The middle shape.</summary>
            [Serializable]
            public class Middle
            {
                public List<int> Values { get; } = new();
            }

            public class After { }
            """,
        [Block] = """
            namespace Geometry
            {
                public class First { }

                public class Worker { }
            }
            """,
        [Global] = """
            public class Alpha { }

            public class Standalone { }
            """,
        [Attributed] = """
            using System;

            namespace Legacy;

            public class Keeper { }

            /// <summary>A serializable legacy value.</summary>
            [Serializable]
            public class LegacyValue { }
            """,
        [Generics] = """
            namespace Boxes;

            public class Box<T>
            {
                public T? Value { get; set; }
            }

            public class Other { }
            """,
        [Containers] = """
            namespace Nesting;

            public class Outer
            {
                public class Inner { }

                public class Sibling { }
            }
            """,
        [Matched] = """
            namespace Matching;

            public class AlreadyMatched { }
            """,
        [Spacing] = """
            namespace Spacing;

            public class First { }

            public class Beta { }
            """,
    };

    private readonly RefactoringProject _project = new("MoveToFile", Files);

    public void Dispose()
    {
        _project.Dispose();
    }

    [Fact]
    public async Task File_scoped_move_preserves_siblings_usings_documentation_and_attributes()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(manager, Many, "public class Middle", "Middle", "Move type to Middle.cs");
        var created = edit.DocumentChanges.Single(change => change.Create);
        var newFile = _project.After(edit, "Middle.cs");
        var source = _project.After(edit, Many);
        Assert.Equal(2, edit.DocumentChanges.Count);
        Assert.True(created.Create);
        Assert.Equal(_project.PathOf("Middle.cs"), created.FilePath);
        Assert.Contains("using System;", newFile);
        Assert.Contains("using System.Collections.Generic;", newFile);
        Assert.Contains("namespace Shapes;", newFile);
        Assert.Contains("public class Middle", newFile);
        Assert.Contains("/// <summary>The middle shape.</summary>", newFile);
        Assert.Contains("[Serializable]", newFile);
        Assert.DoesNotContain("class Before", newFile);
        Assert.DoesNotContain("class After", newFile);
        Assert.Contains("class Before", source);
        Assert.Contains("class After", source);
        Assert.Contains("using System.Collections.Generic;", source);
        Assert.DoesNotContain("class Middle", source);
        Assert.DoesNotContain("The middle shape", source);
        Assert.DoesNotContain("[Serializable]", source);
        Assert.Empty(ParseErrors(newFile));
        Assert.Empty(ParseErrors(source));
    }

    [Fact]
    public async Task Block_scoped_namespace_remains_block_scoped()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(manager, Block, "    public class Worker { }", "Worker", "Move type to Worker.cs");
        var newFile = _project.After(edit, "Worker.cs");
        var source = _project.After(edit, Block);
        Assert.Equal(2, edit.DocumentChanges.Count);
        Assert.Equal(_project.PathOf("Worker.cs"), edit.DocumentChanges.Single(change => change.Create).FilePath);
        Assert.Contains("namespace Geometry", newFile);
        Assert.Contains("{", newFile);
        Assert.DoesNotContain("namespace Geometry;", newFile);
        Assert.Contains("public class Worker", newFile);
        Assert.Contains("public class First", source);
        Assert.DoesNotContain("class Worker", source);
        Assert.Empty(ParseErrors(newFile));
        Assert.Empty(ParseErrors(source));
    }

    [Fact]
    public async Task Type_without_a_namespace_moves_without_gaining_one()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(manager, Global, "public class Standalone { }", "Standalone", "Move type to Standalone.cs");
        var newFile = _project.After(edit, "Standalone.cs");
        var source = _project.After(edit, Global);
        Assert.Equal(2, edit.DocumentChanges.Count);
        Assert.Equal(_project.PathOf("Standalone.cs"), edit.DocumentChanges.Single(change => change.Create).FilePath);
        Assert.Contains("public class Standalone", newFile);
        Assert.DoesNotContain("namespace ", newFile);
        Assert.DoesNotContain("class Alpha", newFile);
        Assert.Contains("public class Alpha", source);
        Assert.DoesNotContain("class Standalone", source);
        Assert.Empty(ParseErrors(newFile));
        Assert.Empty(ParseErrors(source));
    }

    [Fact]
    public async Task Documentation_and_serializable_attribute_leave_the_source_with_the_type()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(manager, Attributed, "public class LegacyValue { }", "LegacyValue", "Move type to LegacyValue.cs");
        var newFile = _project.After(edit, "LegacyValue.cs");
        var source = _project.After(edit, Attributed);
        Assert.Equal(2, edit.DocumentChanges.Count);
        Assert.Contains("using System;", newFile);
        Assert.Contains("namespace Legacy;", newFile);
        Assert.Contains("public class LegacyValue", newFile);
        Assert.Contains("/// <summary>A serializable legacy value.</summary>", newFile);
        Assert.Contains("[Serializable]", newFile);
        Assert.DoesNotContain("A serializable legacy value", source);
        Assert.DoesNotContain("[Serializable]", source);
        Assert.DoesNotContain("class LegacyValue", source);
        Assert.Contains("public class Keeper", source);
        Assert.Empty(ParseErrors(newFile));
        Assert.Empty(ParseErrors(source));
    }

    [Fact]
    public async Task Generic_type_moves_to_Box_cs_without_arity_in_the_file_name()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(manager, Generics, "public class Box<T>", "Box", "Move type to Box.cs");
        var newFile = _project.After(edit, "Box.cs");
        var source = _project.After(edit, Generics);
        Assert.Equal(2, edit.DocumentChanges.Count);
        Assert.Equal(_project.PathOf("Box.cs"), edit.DocumentChanges.Single(change => change.Create).FilePath);
        Assert.Contains("namespace Boxes;", newFile);
        Assert.Contains("public class Box<T>", newFile);
        Assert.Contains("public T? Value { get; set; }", newFile);
        Assert.DoesNotContain("class Other", newFile);
        Assert.DoesNotContain("class Box", source);
        Assert.Contains("public class Other", source);
        Assert.Empty(ParseErrors(newFile));
        Assert.Empty(ParseErrors(source));
    }

    [Fact]
    public async Task Nested_type_moves_inside_a_partial_copy_of_its_container()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(manager, Containers, "    public class Inner { }", "Inner");
        Assert.Contains(actions, action => action.Title == "Move 'Inner' out of 'Outer' to Inner.cs");
        var edit = await _project.ApplyAsync(manager, Containers, "    public class Inner { }", "Inner", "Move type to Inner.cs");
        var newFile = _project.After(edit, "Inner.cs");
        var source = _project.After(edit, Containers);
        Assert.Equal(2, edit.DocumentChanges.Count);
        Assert.Equal(_project.PathOf("Inner.cs"), edit.DocumentChanges.Single(change => change.Create).FilePath);
        Assert.Contains("namespace Nesting;", newFile);
        Assert.Contains("partial class Outer", newFile);
        Assert.Contains("public class Inner", newFile);
        Assert.DoesNotContain("class Sibling", newFile);
        Assert.Contains("public partial class Outer", source);
        Assert.Contains("public class Sibling", source);
        Assert.DoesNotContain("class Inner", source);
        Assert.Empty(ParseErrors(newFile));
        Assert.Empty(ParseErrors(source));
    }

    [Fact]
    public async Task Single_type_whose_name_matches_the_file_does_not_offer_the_move()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(manager, Matched, "public class AlreadyMatched { }", "AlreadyMatched");

        Assert.DoesNotContain(actions, action => action.Title.StartsWith("Move type to ", StringComparison.Ordinal));
    }

    [Fact]
    public async Task File_scoped_namespace_has_a_blank_line_before_the_moved_declaration()
    {
        using var manager = await _project.OpenAsync();
        var edit = await _project.ApplyAsync(manager, Spacing, "public class Beta { }", "Beta", "Move type to Beta.cs");
        var newFile = _project.After(edit, "Beta.cs");
        var source = _project.After(edit, Spacing);
        Assert.Equal(2, edit.DocumentChanges.Count);
        Assert.Equal(_project.PathOf("Beta.cs"), edit.DocumentChanges.Single(change => change.Create).FilePath);
        Assert.Contains("namespace Spacing;\n\npublic class Beta", newFile);
        Assert.Contains("public class First", source);
        Assert.DoesNotContain("class Beta", source);
        Assert.Empty(ParseErrors(newFile));
        Assert.Empty(ParseErrors(source));
    }
}
