import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `global.json` SDK pin handling.
 *
 * Implements [DIST-RUNTIME-ACQUIRE]. Every .NET entry point (`dotnet build`,
 * `dotnet test`, MSBuildLocator's `hostfxr_resolve_sdk2`) resolves its SDK
 * through the nearest `global.json` at or above the working directory. An
 * extension that checks only "is some 10.0 SDK present" therefore green-lights
 * an SDK the workspace can never use, and every later `dotnet` call dies with
 * exit code 155 ("A compatible .NET SDK was not found").
 */

/** The `rollForward` policies `global.json` accepts, per the .NET SDK docs. */
export type RollForward =
  | 'patch'
  | 'feature'
  | 'minor'
  | 'major'
  | 'latestPatch'
  | 'latestFeature'
  | 'latestMinor'
  | 'latestMajor'
  | 'disable';

/** Omitting `rollForward` alongside a `version` means `latestPatch`. */
export const DEFAULT_ROLL_FORWARD: RollForward = 'latestPatch';

const ROLL_FORWARD_VALUES: readonly string[] = [
  'patch',
  'feature',
  'minor',
  'major',
  'latestPatch',
  'latestFeature',
  'latestMinor',
  'latestMajor',
  'disable',
];

/** An SDK version pinned by a `global.json`, and the file it came from. */
export interface SdkPin {
  readonly version: string;
  readonly rollForward: RollForward;
  readonly source: string;
}

/**
 * A parsed SDK version. .NET encodes the third component as `bpp`: `b` is the
 * feature band and `pp` the patch within it, so `10.0.303` is band `300`
 * patch `3` and `10.0.203` is band `200` patch `3` — a different band, which
 * is why `latestPatch` can never roll `10.0.203` up to satisfy `10.0.303`.
 */
interface SdkVersion {
  readonly major: number;
  readonly minor: number;
  readonly band: number;
  readonly patch: number;
}

/** Parse `major.minor.bpp`, ignoring any prerelease suffix. Undefined if malformed. */
export function parseSdkVersion(version: string): SdkVersion | undefined {
  const parts = (version.split('-')[0] ?? '').split('.');
  if (parts.length < 3) return undefined;
  const numbers = parts.slice(0, 3).map((part) => Number(part));
  if (!numbers.every((value) => Number.isInteger(value) && value >= 0)) return undefined;
  const [major = 0, minor = 0, third = 0] = numbers;
  return { major, minor, band: Math.floor(third / 100) * 100, patch: third % 100 };
}

/** Order two versions by major, minor, band, then patch. */
function compare(left: SdkVersion, right: SdkVersion): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.band - right.band ||
    left.patch - right.patch
  );
}

/**
 * Whether one installed SDK satisfies `pin` under its `rollForward` policy.
 *
 * Every policy is "at least the pinned version"; they differ only in how far
 * up the version they may roll — patch within the band, band within the minor,
 * and so on. `disable` demands an exact match.
 */
export function sdkSatisfiesPin(installed: string, pin: SdkPin): boolean {
  if (pin.rollForward === 'disable') return installed === pin.version;
  const want = parseSdkVersion(pin.version);
  const got = parseSdkVersion(installed);
  if (want === undefined || got === undefined) return false;
  if (compare(got, want) < 0) return false;
  if (got.major !== want.major && !isMajorPolicy(pin.rollForward)) return false;
  if (got.minor !== want.minor && !isMinorPolicy(pin.rollForward)) return false;
  return got.band === want.band || isFeaturePolicy(pin.rollForward);
}

function isFeaturePolicy(rollForward: RollForward): boolean {
  return rollForward !== 'patch' && rollForward !== 'latestPatch';
}

function isMinorPolicy(rollForward: RollForward): boolean {
  return ['minor', 'latestMinor', 'major', 'latestMajor'].includes(rollForward);
}

function isMajorPolicy(rollForward: RollForward): boolean {
  return rollForward === 'major' || rollForward === 'latestMajor';
}

/** Whether any installed SDK satisfies the pin. */
export function pinSatisfiedBy(installed: readonly string[], pin: SdkPin): boolean {
  return installed.some((version) => sdkSatisfiesPin(version, pin));
}

/** The nearest `global.json` at or above `startDir`, if any. */
export function findGlobalJson(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'global.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Read one property of a parsed JSON object without asserting its shape. */
function field(source: object, name: string): unknown {
  return Reflect.get(source, name);
}

/** Whether a value is one of the `rollForward` policies the SDK defines. */
function isRollForward(value: unknown): value is RollForward {
  return typeof value === 'string' && ROLL_FORWARD_VALUES.includes(value);
}

/** Read the SDK pin governing `startDir`. Undefined when unpinned or unreadable. */
export function readSdkPin(startDir: string): SdkPin | undefined {
  const source = findGlobalJson(startDir);
  if (source === undefined) return undefined;
  const sdk = readSdkSection(source);
  if (sdk === undefined) return undefined;
  const version = field(sdk, 'version');
  if (typeof version !== 'string' || version.length === 0) return undefined;
  const declared = field(sdk, 'rollForward');
  return {
    version,
    rollForward: isRollForward(declared) ? declared : DEFAULT_ROLL_FORWARD,
    source,
  };
}

/** The `sdk` object of a `global.json`, or undefined when absent or malformed. */
function readSdkSection(source: string): object | undefined {
  const parsed = parseJson(source);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const sdk = field(parsed, 'sdk');
  return typeof sdk === 'object' && sdk !== null ? sdk : undefined;
}

function parseJson(source: string): unknown {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
    return parsed;
  } catch {
    return undefined;
  }
}

/** SDK versions installed beside a `dotnet` executable, newest last. */
export function installedSdkVersions(dotnetPath: string): readonly string[] {
  try {
    return fs
      .readdirSync(path.join(path.dirname(dotnetPath), 'sdk'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => parseSdkVersion(name) !== undefined)
      .sort();
  } catch {
    return [];
  }
}
