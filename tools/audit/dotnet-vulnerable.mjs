#!/usr/bin/env node
// Implements [DIST-CI-AUDIT].
//
// Reports every NuGet package that `dotnet list package --vulnerable
// --include-transitive --format json` flagged, and exits non-zero when any of
// them reaches the fail level. `dotnet list` itself exits 0 whatever it finds,
// so without this check a vulnerable sidecar dependency would pass the gate.
//
// Usage: node tools/audit/dotnet-vulnerable.mjs <report.json> [low|moderate|high|critical]
// Exit:  0 clean below the fail level, 1 vulnerable, 2 unusable report or usage.
import { readFileSync } from "node:fs";

const SEVERITIES = ["low", "moderate", "high", "critical"];

const rank = (severity) => SEVERITIES.indexOf(severity.toLowerCase());

const UPGRADE_HINT = {
  true: "raise its PackageReference to a version the advisory lists as patched",
  false: "pin a patched version with a direct PackageReference, or upgrade the package that pulls it in",
};

function packageFindings(project, framework, packages, direct) {
  return (packages ?? []).flatMap((pkg) =>
    pkg.vulnerabilities.map((vulnerability) => ({
      project: project.path,
      framework: framework.framework,
      id: pkg.id,
      version: pkg.resolvedVersion,
      direct,
      severity: vulnerability.severity.toLowerCase(),
      advisory: vulnerability.advisoryurl,
    })),
  );
}

function findings(report) {
  return report.projects.flatMap((project) =>
    (project.frameworks ?? []).flatMap((framework) => [
      ...packageFindings(project, framework, framework.topLevelPackages, true),
      ...packageFindings(project, framework, framework.transitivePackages, false),
    ]),
  );
}

function describe(finding) {
  const kind = finding.direct ? "direct" : "transitive";
  return [
    `  ${finding.severity.toUpperCase().padEnd(8)} ${finding.id} ${finding.version} (${kind})`,
    `           in ${finding.project} [${finding.framework}]`,
    `           advisory: ${finding.advisory}`,
    `           upgrade:  ${UPGRADE_HINT[finding.direct]}`,
  ].join("\n");
}

function parse(path) {
  try {
    return { report: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: `${path}: ${err.message}` };
  }
}

function readReport(path) {
  const { report, error } = parse(path);
  if (error !== undefined) {
    return { error };
  }
  const errors = (report.problems ?? []).filter((problem) => problem.level === "error");
  return errors.length === 0 ? { report } : { error: errors.map((problem) => problem.text).join("\n") };
}

function main([path, level = "moderate"]) {
  if (path === undefined || rank(level) < 0) {
    process.stderr.write(`usage: dotnet-vulnerable.mjs <report.json> [${SEVERITIES.join("|")}]\n`);
    return 2;
  }
  const { report, error } = readReport(path);
  if (error !== undefined) {
    process.stderr.write(`ERROR: dotnet could not audit the solution:\n${error}\n`);
    return 2;
  }
  const found = findings(report);
  const failing = found.filter((finding) => rank(finding.severity) >= rank(level));
  found.forEach((finding) => process.stdout.write(`${describe(finding)}\n`));
  process.stdout.write(`${found.length} vulnerable NuGet package(s), ${failing.length} at or above '${level}'.\n`);
  return failing.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
