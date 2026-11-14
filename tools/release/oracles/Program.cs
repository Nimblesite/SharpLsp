using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length != 1)
    return 2;
var root = CSharpSyntaxTree.ParseText(File.ReadAllText(args[0])).GetRoot();
var methods = root.DescendantNodes()
    .OfType<MethodDeclarationSyntax>()
    .Where(method => method.Identifier.ValueText == "Serialize" && method.Body is not null)
    .ToArray();
var stubs = methods.Count(method =>
    method.Body!.Statements.Count == 0
    || (
        method.Body.Statements.Count == 1
        && method.Body.Statements[0] is ThrowStatementSyntax statement
        && statement.Expression?.IsKind(SyntaxKind.NullLiteralExpression) == true
    )
);
using var output = Console.OpenStandardOutput();
output.Write(
    JsonSerializer.SerializeToUtf8Bytes(
        new
        {
            RuntimeAssemblyExists = File.Exists(typeof(JsonSerializer).Assembly.Location),
            Total = methods.Length,
            Stubs = stubs,
            Implementations = methods.Length - stubs,
        }
    )
);
return 0;
