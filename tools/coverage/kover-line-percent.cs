#:property EnforceExtendedAnalyzerRules=false

// Print the roll-up line-coverage percentage from a Kover XML report, for
// `check-coverage.mjs` to gate on. [DIST-CI-RIDER]
//
// Kover emits a JaCoCo-shaped document: every <package>, <class> and <method>
// repeats the counters for its own scope, and <report> carries the totals as
// direct children. Reading a descendant counter would score one arbitrary
// class instead of the plugin.

using System.Globalization;
using System.Xml.Linq;

if (args.Length != 1)
{
    Console.Error.WriteLine("usage: kover-line-percent.cs <kover-report.xml>");
    return 2;
}

var reportPath = args[0];
if (!File.Exists(reportPath))
{
    Console.Error.WriteLine($"ERROR: no Kover report at {reportPath}");
    return 1;
}

var root = XDocument.Load(reportPath).Root;
var counter = root?
    .Elements("counter")
    .FirstOrDefault(element => (string?)element.Attribute("type") == "LINE");

if (counter is null)
{
    Console.Error.WriteLine($"ERROR: {reportPath} has no report-level LINE counter");
    return 1;
}

var missed = (long?)counter.Attribute("missed") ?? 0L;
var covered = (long?)counter.Attribute("covered") ?? 0L;
var total = missed + covered;

if (total == 0)
{
    Console.Error.WriteLine($"ERROR: {reportPath} reports zero instrumented lines");
    return 1;
}

var percent = 100.0 * covered / total;
Console.WriteLine(percent.ToString("G17", CultureInfo.InvariantCulture));
return 0;
