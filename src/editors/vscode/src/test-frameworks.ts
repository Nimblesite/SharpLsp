/**
 * Target frameworks in the Test Explorer: which framework built each assembly,
 * which frameworks each test exists in, and which framework a result came from.
 *
 * A project may target `net462;net472;net48;net8.0;net10.0` at once. VSTest
 * builds and runs one assembly per framework, so the framework is the missing
 * dimension between a test id (one per project) and a TRX row (one per framework
 * per data row). Pure: no process, no VS Code.
 *
 * Implements [NETFX-TEST-DISCOVERY] and [NETFX-TEST-RESULTS].
 */

import * as path from 'node:path';
import type { FrameworkBuild, TestAssemblyListing } from './test-listing-model.js';
import type { TrxTestResult } from './test-trx.js';

/** Tag id prefix a multi-targeted project's tests carry, one per framework. */
export const TFM_TAG_PREFIX = 'tfm:';

/** The identifiers VSTest writes in a banner's `<Identifier>,Version=v<x>`. */
const NET_FRAMEWORK = '.NETFramework';
const NET_CORE_APP = '.NETCoreApp';
const NET_STANDARD = '.NETStandard';
const VERSION_KEY = 'Version=v';

/**
 * The short moniker for a banner's framework name, as `<TargetFrameworks>`
 * spells it: `.NETFramework,Version=v4.8` → `net48`, `.NETCoreApp,Version=v8.0`
 * → `net8.0`, `.NETCoreApp,Version=v3.1` → `netcoreapp3.1`,
 * `.NETStandard,Version=v2.0` → `netstandard2.0`. Anything else is returned
 * verbatim: a label that says too much beats one that guesses.
 */
export function frameworkMoniker(frameworkName: string): string {
  const [identifier, versionPart] = frameworkName.split(',').map((part) => part.trim());
  const version =
    versionPart?.startsWith(VERSION_KEY) === true
      ? versionPart.slice(VERSION_KEY.length)
      : undefined;
  if (identifier === undefined || version === undefined || version === '') return frameworkName;
  if (identifier === NET_FRAMEWORK) return `net${version.replaceAll('.', '')}`;
  if (identifier === NET_STANDARD) return `netstandard${version}`;
  if (identifier !== NET_CORE_APP) return frameworkName;
  const major = Number.parseInt(version, 10);
  return major >= 5 ? `net${version}` : `netcoreapp${version}`;
}

/**
 * True for a .NET Framework moniker: `net` followed by digits only (`net48`,
 * `net462`, `net481`). .NET 5+ monikers carry a dot (`net8.0`) and .NET
 * Standard/Core ones a longer prefix, so no other moniker has this shape.
 */
export function isNetFramework(moniker: string): boolean {
  const digits = moniker.startsWith('net') ? moniker.slice(3) : '';
  return digits !== '' && String(Number.parseInt(digits, 10)) === digits;
}

/** The family prefixes a moniker's version follows, longest first. */
const FAMILY_PREFIXES = ['netstandard', 'netcoreapp', 'net'];

/** `net8.0-windows` → `8.0`; `netstandard2.0` → `2.0`; `net48` → `48`. */
function versionText(moniker: string): string {
  const prefix = FAMILY_PREFIXES.find((each) => moniker.startsWith(each)) ?? '';
  return moniker.slice(prefix.length).split('-')[0] ?? '';
}

/** Family order in every framework list: .NET Framework, .NET Standard, then .NET. */
function familyRank(moniker: string): number {
  if (isNetFramework(moniker)) return 0;
  if (moniker.startsWith('netstandard')) return 1;
  return moniker.startsWith('net') ? 2 : 3;
}

/** `net462` → [4,6,2]; `net8.0` → [8,0]; `netstandard2.0` → [2,0]. */
function versionParts(moniker: string): number[] {
  const text = versionText(moniker);
  return isNetFramework(moniker)
    ? Array.from({ length: text.length }, (_, at) => Number(text.charAt(at)))
    : text.split('.').filter((part) => part !== '').map(Number);
}

/** Orders monikers by family, then version: `net462 < net48 < net481 < net8.0 < net10.0`. */
export function compareFrameworks(left: string, right: string): number {
  const family = familyRank(left) - familyRank(right);
  if (family !== 0) return family;
  const [a, b] = [versionParts(left), versionParts(right)];
  const index = a.findIndex((part, at) => part !== (b[at] ?? -1));
  if (index !== -1) return (a[index] ?? 0) - (b[index] ?? -1);
  return a.length - b.length;
}

/**
 * A multi-targeted root's description: every framework build, ordered, with one
 * that listed nothing while a sibling did (a missing runtime, a crashed host)
 * named as such rather than silently dropped.
 */
export function frameworkSummary(builds: readonly FrameworkBuild[]): string {
  const anyListed = builds.some((build) => build.names.length > 0);
  return [...builds]
    .sort((left, right) => compareFrameworks(left.framework, right.framework))
    .map((build) =>
      anyListed && build.names.length === 0 ? `${build.framework} (nothing listed)` : build.framework,
    )
    .join(' · ');
}

/** One failing framework's account of a test: its assertion text and stack. */
export interface FrameworkFailure {
  readonly framework: string;
  readonly text: string;
}

/**
 * One failure per FAILING framework, ordered, when the result's rows came from
 * two or more frameworks; `undefined` for a single-framework result, which keeps
 * its one unprefixed message.
 */
export function perFrameworkFailures(
  result: TrxTestResult,
  index: FrameworkIndex,
): FrameworkFailure[] | undefined {
  const sources = result.sources ?? [];
  const frameworkOf = (source: string): string => index.frameworkOf(source);
  if (new Set(sources.map((row) => frameworkOf(row.source))).size < 2) return undefined;
  const failures = new Map<string, string>();
  for (const row of sources.filter((each) => each.outcome === 'failed')) {
    const framework = frameworkOf(row.source);
    const text = [row.message, row.stackTrace].filter((part) => part !== undefined).join('\n');
    if (!failures.has(framework)) failures.set(framework, text === '' ? 'Test failed' : text);
  }
  return [...failures]
    .sort(([left], [right]) => compareFrameworks(left, right))
    .map(([framework, text]) => ({ framework, text }));
}

/** Stable comparison key for an assembly path VSTest and TRX spell differently. */
function pathKey(assembly: string): string {
  return path.normalize(assembly).toLowerCase();
}

/**
 * Everything a sweep learned about frameworks, indexed for the three questions
 * the Test Explorer asks: which frameworks does this test exist in, which built
 * assemblies belong to this framework, and which framework built this result's
 * assembly.
 */
export class FrameworkIndex {
  private readonly byAssembly = new Map<string, string>();
  private readonly byTest = new Map<string, Set<string>>();
  private readonly assemblies = new Map<string, string[]>();
  private readonly multiTargeted = new Set<string>();
  private readonly unlistedByTest = new Map<string, readonly string[]>();

  /** Index every framework build the listings reported. */
  constructor(listings: readonly TestAssemblyListing[] = []) {
    for (const listing of listings) this.add(listing);
  }

  private add(listing: TestAssemblyListing): void {
    const builds = listing.frameworks ?? [];
    const unlisted = builds.filter((build) => build.names.length === 0).map((b) => b.framework);
    for (const name of listing.names) this.unlistedByTest.set(name, unlisted);
    for (const build of builds) {
      this.byAssembly.set(pathKey(build.path), build.framework);
      this.assemblies.set(build.framework, [
        ...(this.assemblies.get(build.framework) ?? []),
        build.path,
      ]);
      for (const name of build.names) {
        this.byTest.set(name, (this.byTest.get(name) ?? new Set()).add(build.framework));
      }
    }
    if (builds.length > 1) for (const build of builds) this.multiTargeted.add(build.framework);
  }

  /** The frameworks whose assembly lists `testId`, in discovery order. */
  public frameworksOf(testId: string): string[] {
    return [...(this.byTest.get(testId) ?? [])];
  }

  /** Every built assembly of `framework`. */
  public assembliesFor(framework: string): string[] {
    return [...(this.assemblies.get(framework) ?? [])];
  }

  /**
   * Frameworks of the selected tests' projects whose build listed NOTHING — a
   * missing runtime, a crashed host — so a run can name them ([NETFX-SCOPE]).
   */
  public unlistedFrameworks(ids: readonly string[]): string[] {
    const frameworks = ids.flatMap((id) => this.unlistedByTest.get(id) ?? []);
    return [...new Set(frameworks)].sort(compareFrameworks);
  }

  /** The frameworks some multi-targeted project builds — one profile each. */
  public multiTargetFrameworks(): string[] {
    return [...this.multiTargeted];
  }

  /**
   * The framework that built `source` (a TRX `codeBase`): the banner's, else
   * the name of the directory the assembly sits in (`bin/Debug/net48/X.dll`).
   */
  public frameworkOf(source: string): string {
    return this.byAssembly.get(pathKey(source)) ?? path.basename(path.dirname(source));
  }
}

/** How a Debug request treats .NET Framework ([NETFX-DEBUG]). */
export interface DebugPlan {
  /** Tests that exist ONLY in .NET Framework builds: refused, never started. */
  readonly refused: readonly string[];
  /**
   * The .NET frameworks to debug the rest under, when some of them also exist
   * in a .NET Framework build whose host no bundled debugger can attach to;
   * `undefined` when no .NET Framework build is involved at all.
   */
  readonly frameworks: readonly string[] | undefined;
}

/** Split a Debug selection by the frameworks its tests exist in. */
export function debugPlan(ids: readonly string[], index: FrameworkIndex): DebugPlan {
  const frameworksOf = (id: string): string[] => index.frameworksOf(id);
  const netFrameworkOnly = (id: string): boolean =>
    frameworksOf(id).length > 0 && frameworksOf(id).every(isNetFramework);
  const debuggable = ids.filter((id) => !netFrameworkOnly(id));
  const involved = debuggable.flatMap(frameworksOf);
  const net = [...new Set(involved.filter((framework) => !isNetFramework(framework)))];
  return {
    refused: ids.filter(netFrameworkOnly),
    frameworks: involved.some(isNetFramework) ? net.sort(compareFrameworks) : undefined,
  };
}

/** The refusal a .NET Framework-only test earns under the Debug profile. */
export function netFrameworkDebugRefusal(label: string): string {
  return (
    `${label} runs on .NET Framework, and no .NET Framework debugger is bundled: Debug ` +
    'attaches to .NET only. Use Run, or debug the test under one of its .NET target frameworks.'
  );
}
