import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import * as log from './log.js';
import { getErrorMessage } from './utils.js';

const execFileAsync = promisify(execFile);

// Note: removeNuGetPackage still uses direct CLI here because it's called
// from the solution explorer context menu where the LSP client may not
// be readily available. The NuGet browser panel uses LSP exclusively
// via sharplsp/nuget/* custom requests.

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (tagName) => tagName === 'PackageReference' || tagName === 'ProjectReference',
});

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

/** Shape emitted by fast-xml-parser for a PackageReference/ProjectReference element. */
interface XmlRefElement {
  readonly '@_Include'?: string;
  readonly '@_Version'?: string;
}

/** Shape emitted by fast-xml-parser for an ItemGroup element. */
interface XmlItemGroup {
  readonly PackageReference?: XmlRefElement[];
  readonly ProjectReference?: XmlRefElement[];
}

/** Shape emitted by fast-xml-parser for a Project element. */
interface XmlProject {
  readonly ItemGroup?: XmlItemGroup | XmlItemGroup[];
}

/** Top-level shape emitted by fast-xml-parser for a .csproj/.fsproj. */
interface XmlDocument {
  readonly Project?: XmlProject;
}

// ── Parsing ──────────────────────────────────────────────────────

/** Parse NuGet packages and project references from a .csproj/.fsproj. */
export function parseProjectDependencies(projectPath: string): ProjectDependencies {
  try {
    const content = fs.readFileSync(projectPath, 'utf-8');
    return parseProjectXml(content);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.traceInfo(`Failed to parse deps for ${projectPath}: ${msg}`);
    return { nugetPackages: [], projectReferences: [] };
  }
}

/** Parse project XML content into dependencies. Exported for testing. */
export function parseProjectXml(content: string): ProjectDependencies {
  if (XMLValidator.validate(content) !== true) {
    return emptyProjectDependencies();
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- fast-xml-parser returns untyped output; XmlDocument mirrors the known csproj/fsproj structure
    const doc: XmlDocument = xmlParser.parse(content);
    const itemGroups = collectItemGroups(doc);
    return {
      nugetPackages: extractPackageReferences(itemGroups),
      projectReferences: extractProjectReferences(itemGroups),
    };
  } catch {
    return emptyProjectDependencies();
  }
}

function emptyProjectDependencies(): ProjectDependencies {
  return { nugetPackages: [], projectReferences: [] };
}

function collectItemGroups(doc: XmlDocument): XmlItemGroup[] {
  const project = doc.Project;
  if (project === undefined) return [];
  const groups = project.ItemGroup;
  if (groups === undefined) return [];
  return Array.isArray(groups) ? groups : [groups];
}

function extractPackageReferences(itemGroups: XmlItemGroup[]): NuGetPackage[] {
  const packages: NuGetPackage[] = [];
  for (const group of itemGroups) {
    const refs = group.PackageReference;
    if (refs === undefined) continue;
    for (const ref of refs) {
      const name = ref['@_Include'];
      if (name === undefined) continue;
      const version = ref['@_Version'] ?? '';
      packages.push({ name, version });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function extractProjectReferences(itemGroups: XmlItemGroup[]): ProjectReference[] {
  const refs: ProjectReference[] = [];
  for (const group of itemGroups) {
    const projRefs = group.ProjectReference;
    if (projRefs === undefined) continue;
    for (const ref of projRefs) {
      const includePath = ref['@_Include'];
      if (includePath === undefined) continue;
      const name = path.basename(includePath, path.extname(includePath));
      refs.push({ name, includePath });
    }
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Removal ──────────────────────────────────────────────────────

/** Remove a NuGet package from a project via `dotnet remove`. */
export async function removeNuGetPackage(
  projectPath: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    log.info(`Removing NuGet package ${packageName} from ${projectPath}`);
    await execFileAsync('dotnet', ['remove', projectPath, 'package', packageName]);
    return undefined;
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.info(`Failed to remove NuGet package: ${msg}`);
    return msg;
  }
}

/** Add a project reference to a project via `dotnet add`. */
export async function addProjectReference(
  projectPath: string,
  referencePath: string,
): Promise<string | undefined> {
  try {
    log.info(`Adding project reference ${referencePath} to ${projectPath}`);
    await execFileAsync('dotnet', ['add', projectPath, 'reference', referencePath]);
    return undefined;
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.info(`Failed to add project reference: ${msg}`);
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
    await execFileAsync('dotnet', ['remove', projectPath, 'reference', referencePath]);
    return undefined;
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.info(`Failed to remove project reference: ${msg}`);
    return msg;
  }
}
