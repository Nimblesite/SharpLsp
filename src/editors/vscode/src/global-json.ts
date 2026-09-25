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

/** Parse `major.minor.bpp`, ignoring any prerelease or build suffix. Undefined if malformed. */
export function parseSdkVersion(version: string): SdkVersion | undefined {
  const parts = releaseCore(version).split('.');
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
 *
 * "At least" is SEMVER ordering, so a prerelease sits below its own release.
 * `compare` cannot see that on its own: it is built from `parseSdkVersion`,
 * which discards the suffix because SDK band arithmetic needs it gone. That
 * left `10.0.100-rc.1` tied with `10.0.100` and clearing a pin it sits under —
 * and the SDK resolver does not agree, so every `dotnet` command on the root
 * chosen that way fails the pin with exit 155. Only the TIE was ever wrong:
 * a prerelease of a later band is genuinely above the pin and still passes.
 */
export function sdkSatisfiesPin(installed: string, pin: SdkPin): boolean {
  if (pin.rollForward === 'disable') return installed === pin.version;
  const want = parseSdkVersion(pin.version);
  const got = parseSdkVersion(installed);
  if (want === undefined || got === undefined) return false;
  const order = compare(got, want);
  if (order < 0) return false;
  if (order === 0 && comparePrerelease(prereleaseOf(installed), prereleaseOf(pin.version)) < 0) {
    return false;
  }
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

/**
 * Whether any `installed` runtime reaches the release version `minimum`.
 *
 * The sidecars are framework-dependent `net10.0` apps, so a root must ship a
 * `Microsoft.NETCore.App` at or above their framework version to start them —
 * a question about `shared/`, not about `sdk/`, and independent of the
 * workspace pin. Both are necessary and each can fail while the other passes.
 *
 * A prerelease sorts BELOW its own release, which is the whole reason this
 * cannot reuse `sdkSatisfiesPin` or `parseSdkVersion` alone: that parser
 * deliberately discards the prerelease suffix (correct for SDK feature-band
 * arithmetic) and so reads `10.0.0-rc.2` as `10.0.0`. Measured against the
 * real sidecars on single-runtime roots: `10.0.0-rc.2` exits 150, while
 * `10.0.99-rc.1` and `11.0.0-preview.1` start them — the rule is ordering, not
 * prerelease-ness, and `RollForward=LatestMajor` is what leaves it
 * upward-open. Issue #297.
 */
export function runtimeFloorMet(installed: readonly string[], minimum: string): boolean {
  const want = parseSdkVersion(minimum);
  if (want === undefined) return false;
  return installed.some((version) => clearsFloor(version, want));
}

/** One runtime against the floor: strictly above it, or exactly it and released. */
function clearsFloor(version: string, want: SdkVersion): boolean {
  const got = parseSdkVersion(version);
  if (got === undefined) return false;
  const order = compare(got, want);
  return order > 0 || (order === 0 && !isPrerelease(version));
}

/**
 * `major.minor.patch`, with any prerelease and build suffix removed.
 *
 * Build metadata is stripped FIRST because semver orders it last
 * (`1.2.3-rc.1+sha`), so cutting at `-` alone leaves `0+sha` in the third
 * component, `Number` reads it as `NaN`, and the whole version parses as
 * undefined — a runtime hostfxr accepts, rejected as malformed.
 */
function releaseCore(version: string): string {
  const withoutBuild = version.split('+')[0] ?? '';
  return withoutBuild.split('-')[0] ?? '';
}

/**
 * The prerelease part of a version, or undefined when it is a release.
 *
 * Build metadata carries no precedence and may itself contain `-`
 * (`10.0.0+build-5` is a release), so it is cut before the question is asked.
 */
function prereleaseOf(version: string): string | undefined {
  const core = version.split('+')[0] ?? '';
  const at = core.indexOf('-');
  return at === -1 ? undefined : core.slice(at + 1);
}

/** Whether this version is a prerelease, which sorts BELOW its own release. */
function isPrerelease(version: string): boolean {
  return prereleaseOf(version) !== undefined;
}

/**
 * Semver prerelease ordering, asked only at equal `major.minor.band.patch`.
 *
 * An absent prerelease is the release itself, which outranks every prerelease
 * of the same number. Otherwise the dot-separated identifiers are compared
 * left to right, and a shorter list sorts below a longer one whose leading
 * identifiers match — so `rc` < `rc.1` < `rc.2` < `rc.10`.
 */
function comparePrerelease(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const ours = left.split('.');
  const theirs = right.split('.');
  for (let index = 0; index < Math.max(ours.length, theirs.length); index += 1) {
    const order = compareIdentifier(ours[index], theirs[index]);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Whether an identifier is NUMERIC in the semver sense: digits, and at least
 * one of them.
 *
 * Not "something `Number` can parse". `Number` also accepts hex, exponent,
 * binary and octal literals, a leading sign, and whitespace-only or empty
 * strings — `0x10`, `1e3`, `0b11`, `0o17`, `-1` and `""` all become integers.
 * Each one wrongly called numeric is then ranked BELOW every alphanumeric
 * identifier and compared by value rather than lexically, which is backwards
 * on both counts. Every one of those is reachable in a version string; only
 * `+1` is not, because `+` always begins build metadata.
 */
function isNumericIdentifier(identifier: string): boolean {
  return identifier.length > 0 && Array.from(identifier).every((ch) => ch >= '0' && ch <= '9');
}

/**
 * One prerelease identifier. Numeric identifiers compare numerically and rank
 * below any alphanumeric one; a missing identifier ranks below a present one.
 */
function compareIdentifier(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  const ours = isNumericIdentifier(left);
  const theirs = isNumericIdentifier(right);
  if (ours && theirs) return Number(left) - Number(right);
  if (ours) return -1;
  if (theirs) return 1;
  if (left < right) return -1;
  return left > right ? 1 : 0;
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
