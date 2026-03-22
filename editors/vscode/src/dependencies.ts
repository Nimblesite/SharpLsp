import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as log from "./log.js";
import { getErrorMessage } from "./utils.js";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────

export interface NuGetPackage {
  readonly name: string;
  readonly version: string;
}

export interface ProjectReference {
  readonly name: string;
  readonly includePath: string;
}

export interface ProjectDependencies {
  readonly nugetPackages: NuGetPackage[];
  readonly projectReferences: ProjectReference[];
}

// ── Parsing ──────────────────────────────────────────────────────

/** Parse NuGet packages and project references from a .csproj/.fsproj. */
export function parseProjectDependencies(
  projectPath: string,
): ProjectDependencies {
  try {
    const content = fs.readFileSync(projectPath, "utf-8");
    return {
      nugetPackages: parseNuGetPackages(content),
      projectReferences: parseProjectReferences(content),
    };
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.traceInfo(`Failed to parse deps for ${projectPath}: ${msg}`);
    return { nugetPackages: [], projectReferences: [] };
  }
}

function parseNuGetPackages(content: string): NuGetPackage[] {
  const regex = /<PackageReference\s+([^>]*)\/?>/gi;
  return [...content.matchAll(regex)]
    .map((match) => {
      const attrs = match[1] ?? "";
      const name = extractAttribute(attrs, "Include");
      const version = extractAttribute(attrs, "Version");
      return name !== undefined ? { name, version: version ?? "" } : undefined;
    })
    .filter((pkg): pkg is NuGetPackage => pkg !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseProjectReferences(content: string): ProjectReference[] {
  const regex = /<ProjectReference\s+([^>]*)\/?>/gi;
  return [...content.matchAll(regex)]
    .map((match) => {
      const attrs = match[1] ?? "";
      const includePath = extractAttribute(attrs, "Include");
      if (includePath === undefined) return undefined;
      const name = path.basename(includePath, path.extname(includePath));
      return { name, includePath };
    })
    .filter((ref): ref is ProjectReference => ref !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractAttribute(
  attrs: string,
  name: string,
): string | undefined {
  const regex = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
  return regex.exec(attrs)?.[1];
}

// ── Removal ──────────────────────────────────────────────────────

/** Remove a NuGet package from a project via `dotnet remove`. */
export async function removeNuGetPackage(
  projectPath: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    log.info(`Removing NuGet package ${packageName} from ${projectPath}`);
    await execFileAsync("dotnet", [
      "remove", projectPath, "package", packageName,
    ]);
    return undefined;
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.info(`Failed to remove NuGet package: ${msg}`);
    return msg;
  }
}

/** Remove a project reference from a project via `dotnet remove`. */
export async function removeProjectReference(
  projectPath: string,
  referencePath: string,
): Promise<string | undefined> {
  try {
    log.info(`Removing project reference ${referencePath} from ${projectPath}`);
    await execFileAsync("dotnet", [
      "remove", projectPath, "reference", referencePath,
    ]);
    return undefined;
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.info(`Failed to remove project reference: ${msg}`);
    return msg;
  }
}
