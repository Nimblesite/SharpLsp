#:property EnforceExtendedAnalyzerRules=false

using System.Globalization;
using System.Xml.Linq;

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: merge-cobertura.cs <package> <report.xml>...");
    return 2;
}

var packageName = args[0];
var reportPaths = args[1..];
var pathComparer = OperatingSystem.IsWindows()
    ? StringComparer.OrdinalIgnoreCase
    : StringComparer.Ordinal;
var filesToLines = new Dictionary<string, Dictionary<int, long>>(pathComparer);
var reportsWithPackage = 0;

foreach (var reportPath in reportPaths)
{
    var document = XDocument.Load(reportPath);
    var packages = document
        .Descendants("package")
        .Where(element => (string?)element.Attribute("name") == packageName)
        .ToArray();
    if (packages.Length > 0)
    {
        reportsWithPackage++;
    }

    foreach (var package in packages)
    {
        foreach (var classElement in package.Descendants("class"))
        {
            var sourcePath = ((string?)classElement.Attribute("filename"))?.Replace('\\', '/');
            if (sourcePath is null)
            {
                continue;
            }

            if (!filesToLines.TryGetValue(sourcePath, out var lines))
            {
                lines = [];
                filesToLines[sourcePath] = lines;
            }

            foreach (var lineElement in classElement.Descendants("line"))
            {
                var lineNumberText = (string?)lineElement.Attribute("number");
                var hitsText = (string?)lineElement.Attribute("hits");
                if (
                    int.TryParse(
                        lineNumberText,
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out var lineNumber
                    )
                    && lineNumber > 0
                    && long.TryParse(
                        hitsText,
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out var hits
                    )
                )
                {
                    lines[lineNumber] = Math.Max(lines.GetValueOrDefault(lineNumber), hits);
                }
            }
        }
    }
}

var tracked = filesToLines.Values.Sum(lines => lines.Count);
var hit = filesToLines.Values.Sum(lines => lines.Values.Count(count => count > 0));
if (reportsWithPackage == 0 || tracked == 0)
{
    Console.Error.WriteLine(
        $"ERROR: package '{packageName}' has no line records in: {string.Join(", ", reportPaths)}"
    );
    return 1;
}

Console.Error.WriteLine(
    $"merged {reportsWithPackage} reports for {packageName}: {hit}/{tracked} lines covered"
);
Console.WriteLine(((double)hit / tracked * 100).ToString("F4", CultureInfo.InvariantCulture));
return 0;
