// Takes nuget.org out of the NuGet browser suite. Supports [NUGET-WEBVIEW-EXTENSION].
//
// `sharplsp/nuget/search` is the one request in this feature that leaves the
// machine. Asserting against whatever azuresearch-usnc.nuget.org happens to
// return puts the result in the hands of a third party: the old assertions were
// `count > 0` and `count >= 5`, which no product defect can fail — any five
// packages satisfy them — while a slow response fails the whole suite inside its
// 15s budget. There is no correct timeout for a live third-party call, so no wait
// fixes it; the dependency has to go.
//
// Only that one method is intercepted. Targets, installed packages, versions,
// install and uninstall still go to the real LSP over the real project file, so
// the panel is still driven end to end — what changes is that the catalogue it
// searches is known, which is what makes an exact assertion possible at all.
import { type LanguageClient } from 'vscode-languageclient/node';
import { type NuGetSearchResult } from '../../nuget-browser/types.js';

/** The only LSP method this kit answers locally. */
export const SEARCH_METHOD = 'sharplsp/nuget/search';

/** The search request the panel sent, captured exactly as it was sent. */
export interface CapturedSearch {
  readonly query: string;
  readonly take: number;
  readonly skip: number;
  readonly prerelease: boolean;
  readonly projectPath: string;
}

/**
 * The catalogue every stubbed search answers with.
 *
 * Deliberately NOT the real popular-package list: ids that could never come back
 * from nuget.org mean a test that still reaches the network cannot accidentally
 * pass. The order is the order the panel must preserve.
 */
export const SEEDED_PACKAGES: readonly NuGetSearchResult[] = [
  {
    id: 'Sharplsp.Fixture.Alpha',
    version: '1.0.0',
    description: 'First seeded package.',
    authors: 'SharpLsp Tests',
    tags: ['fixture'],
    downloadCount: 900,
    iconUrl: 'https://example.invalid/alpha.png',
    licenseUrl: 'https://example.invalid/alpha-license',
    projectUrl: 'https://example.invalid/alpha-project',
  },
  {
    id: 'Sharplsp.Fixture.Bravo',
    version: '2.1.3',
    description: 'Second seeded package.',
    authors: 'SharpLsp Tests',
    tags: ['fixture'],
    downloadCount: 800,
  },
  {
    id: 'Sharplsp.Fixture.Charlie',
    version: '0.9.1',
    description: 'Third seeded package.',
    authors: 'SharpLsp Tests',
    tags: ['fixture'],
    downloadCount: 700,
  },
  {
    id: 'Sharplsp.Fixture.Delta',
    version: '3.0.0-preview.2',
    description: 'Fourth seeded package.',
    authors: 'SharpLsp Tests',
    tags: ['fixture'],
    downloadCount: 600,
  },
  {
    id: 'Sharplsp.Fixture.Echo',
    version: '1.4.2',
    description: 'Fifth seeded package.',
    authors: 'SharpLsp Tests',
    tags: ['fixture'],
    downloadCount: 500,
  },
  {
    id: 'Sharplsp.Fixture.Foxtrot',
    version: '5.5.5',
    description: 'Sixth seeded package.',
    authors: 'SharpLsp Tests',
    tags: ['fixture'],
    downloadCount: 400,
  },
];

/**
 * The package the NuGetTest fixture actually has installed.
 *
 * Reachable only through a `packageid:` lookup, never through a plain search,
 * which is how the panel enriches installed rows. It carries an icon so the icon
 * assertions are about what the panel renders rather than about whether
 * nuget.org served an image in time.
 */
export const INSTALLED_FIXTURE_PACKAGE: NuGetSearchResult = {
  id: 'Newtonsoft.Json',
  version: '13.0.3',
  description: 'Json.NET is a popular high-performance JSON framework for .NET',
  authors: 'James Newton-King',
  tags: ['json'],
  downloadCount: 1_000_000,
  iconUrl: 'https://example.invalid/newtonsoft.png',
  licenseUrl: 'https://example.invalid/newtonsoft-license',
  projectUrl: 'https://example.invalid/newtonsoft-project',
};

/** Everything a `packageid:` lookup can find. */
const CATALOGUE: readonly NuGetSearchResult[] = [...SEEDED_PACKAGES, INSTALLED_FIXTURE_PACKAGE];

/** The prefix the panel uses to look one package up by id. */
export const BY_ID_PREFIX = 'packageid:';

/**
 * What a stubbed search answers, by the same rules the real feed follows: the
 * empty query is the popular list, `packageid:` is an exact lookup, and anything
 * else is a substring match.
 */
export function answerSearch(query: string): readonly NuGetSearchResult[] {
  if (query.length === 0) return SEEDED_PACKAGES;
  if (query.startsWith(BY_ID_PREFIX)) {
    const wanted = query.slice(BY_ID_PREFIX.length);
    return CATALOGUE.filter((pkg) => pkg.id === wanted);
  }
  const needle = query.toLowerCase();
  return SEEDED_PACKAGES.filter((pkg) => pkg.id.toLowerCase().includes(needle));
}

/** The ids of {@link SEEDED_PACKAGES}, in the order the panel must keep them. */
export const SEEDED_IDS: readonly string[] = SEEDED_PACKAGES.map((pkg) => pkg.id);

/** A client getter with the feed stubbed, plus every search the panel issued. */
export interface StubbedFeed {
  readonly getClient: () => LanguageClient | undefined;
  /** Every `sharplsp/nuget/search` the panel sent, in order. */
  readonly searches: CapturedSearch[];
}

type SendRequest = (method: string, params: unknown) => Promise<unknown>;

/**
 * Wrap a live client so searches are answered from {@link SEEDED_PACKAGES}.
 *
 * A proxy rather than a hand-built fake: every other member stays the real
 * client's, so a panel that starts using some new part of the client keeps
 * working here instead of failing against a fake that was never updated.
 */
export function stubSearchFeed(
  getReal: () => LanguageClient | undefined,
  packages: readonly NuGetSearchResult[] = SEEDED_PACKAGES,
): StubbedFeed {
  const searches: CapturedSearch[] = [];
  const getClient = (): LanguageClient | undefined => {
    const real = getReal();
    if (real === undefined) return undefined;
    return new Proxy(real, {
      get(target, property, receiver): unknown {
        if (property !== 'sendRequest') return Reflect.get(target, property, receiver);
        return async (method: string, params: unknown): Promise<unknown> => {
          const send = Reflect.get(target, 'sendRequest', target) as SendRequest;
          if (method !== SEARCH_METHOD) return send.call(target, method, params);
          const search = params as CapturedSearch;
          searches.push(search);
          const hits = packages === SEEDED_PACKAGES ? answerSearch(search.query) : packages;
          return { packages: hits.map((pkg) => ({ ...pkg })), totalHits: hits.length };
        };
      },
    });
  };
  return { getClient, searches };
}
