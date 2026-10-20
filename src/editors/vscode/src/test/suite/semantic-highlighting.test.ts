// Semantic highlighting as the editor paints it: the legend the server
// advertises, the token type it reports at each keyword, and the theme scope
// VS Code resolves that type through. Implements [SHARPLSP-FEATURES-HIGHLIGHTING]
// "Keyword classes" (#251).
//
// Roslyn tells `if`/`for`/`return` (a control keyword) apart from `public`/`int`
// (a keyword), and Visual Studio colours the two differently. A server that
// reports both as `keyword` paints them one colour over the TextMate grammar
// that had already told them apart, so the distinction must survive the wire.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { contributes } from './run-debug-kit';
import { nthPositionOf } from './fsharp-helpers';
import { useLspTestSuite } from './lsp-suite-kit';
import { openExistingFile, pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

const FIXTURE_DIR = path.resolve(__dirname, '../../../test-fixtures/workspace');

/** One decoded token: where it starts and which legend type it carries. */
interface PaintedToken {
  readonly line: number;
  readonly start: number;
  readonly length: number;
  readonly type: string;
}

/** The legend the server registered for `uri`'s language. */
async function legendFor(uri: vscode.Uri): Promise<vscode.SemanticTokensLegend> {
  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
    'vscode.provideDocumentSemanticTokensLegend',
    uri,
  );
  assert.ok(legend, `the server must advertise a semantic tokens legend for ${uri.fsPath}`);
  return legend;
}

/** Decode the relative `[line, start, length, type, modifiers]` stream. */
function decode(data: Uint32Array, legend: vscode.SemanticTokensLegend): PaintedToken[] {
  const tokens: PaintedToken[] = [];
  let line = 0;
  let start = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i] ?? 0;
    line += deltaLine;
    start = deltaLine === 0 ? start + (data[i + 1] ?? 0) : (data[i + 1] ?? 0);
    const type = legend.tokenTypes[data[i + 3] ?? -1] ?? '<outside the legend>';
    tokens.push({ line, start, length: data[i + 2] ?? 0, type });
  }
  return tokens;
}

/**
 * The full token stream for `uri`, polled until the semantic engine answers: a
 * cold sidecar replies `null` until the project is loaded.
 */
async function paintedTokens(uri: vscode.Uri): Promise<PaintedToken[]> {
  const legend = await legendFor(uri);
  return await pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
        'vscode.provideDocumentSemanticTokens',
        uri,
      );
      return result === undefined ? [] : decode(result.data, legend);
    },
    (decoded) => decoded.length > 0,
    SIDECAR_COLD_MS,
    250,
    `semantic tokens for ${uri.fsPath}`,
  );
}

/** The token type painted over the keyword at `position`, or `undefined` for none. */
function typeAt(tokens: readonly PaintedToken[], at: vscode.Position): string | undefined {
  return tokens.find(
    (token) =>
      token.line === at.line &&
      token.start <= at.character &&
      at.character < token.start + token.length,
  )?.type;
}

/** Each `[needle, occurrence]` in `doc`, with the token type painted there. */
function paintedAt(
  doc: vscode.TextDocument,
  tokens: readonly PaintedToken[],
  needles: readonly (readonly [string, number])[],
): Record<string, string | undefined> {
  return Object.fromEntries(
    needles.map(([needle, occurrence]) => [
      `${needle}#${String(occurrence)}`,
      typeAt(tokens, nthPositionOf(doc, needle, occurrence)),
    ]),
  );
}

suite('Semantic highlighting — keyword classes (#251)', () => {
  useLspTestSuite('semantic-highlighting-');

  test('C# control keywords are painted apart from other keywords, like Visual Studio', async function () {
    this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
    const { doc } = await openExistingFile(FIXTURE_DIR, 'Calculator.cs');

    // Interaction 1: the tokens over Calculator.cs carry the class Roslyn gave them.
    const tokens = await paintedTokens(doc.uri);
    assert.deepStrictEqual(
      paintedAt(doc, tokens, [
        ['return a + b', 0],
        ['if (b == 0)', 0],
        ['throw new', 0],
        ['return a / b', 0],
      ]),
      {
        'return a + b#0': 'controlKeyword',
        'if (b == 0)#0': 'controlKeyword',
        'throw new#0': 'controlKeyword',
        'return a / b#0': 'controlKeyword',
      },
      'flow-control keywords are control keywords',
    );
    assert.deepStrictEqual(
      paintedAt(doc, tokens, [
        ['public class Calculator', 0],
        ['class Calculator', 0],
        ['private readonly', 0],
        ['readonly int', 0],
        ['int _precision', 0],
        ['double Divide', 0],
      ]),
      {
        'public class Calculator#0': 'keyword',
        'class Calculator#0': 'keyword',
        'private readonly#0': 'keyword',
        'readonly int#0': 'keyword',
        'int _precision#0': 'keyword',
        'double Divide#0': 'keyword',
      },
      'modifiers, declarations and predefined types stay plain keywords',
    );

    // Interaction 2: the legend names a control-keyword type beside `keyword`.
    const legend = await legendFor(doc.uri);
    assert.ok(legend.tokenTypes.includes('keyword'), `legend: ${legend.tokenTypes.join(', ')}`);
    assert.ok(
      legend.tokenTypes.includes('controlKeyword'),
      `the legend must name 'controlKeyword'; it has: ${legend.tokenTypes.join(', ')}`,
    );
    assert.strictEqual(
      new Set(legend.tokenTypes).size,
      legend.tokenTypes.length,
      'every legend type is listed once, so each index means one thing',
    );

    // Interaction 3: VS Code resolves the new type through the theme's
    // `keyword.control` scope, falling back to `keyword` where a theme has none.
    const types: unknown = contributes().semanticTokenTypes;
    assert.ok(Array.isArray(types), 'contributes.semanticTokenTypes must be declared');
    const declared = (types as { id?: string; superType?: string; description?: string }[]).find(
      (entry) => entry.id === 'controlKeyword',
    );
    assert.ok(declared, "contributes.semanticTokenTypes must declare 'controlKeyword'");
    assert.strictEqual(declared.superType, 'keyword', 'a control keyword is a kind of keyword');
    assert.ok((declared.description ?? '').length > 0, 'the type carries a description');
    const scopes: unknown = contributes().semanticTokenScopes;
    assert.ok(Array.isArray(scopes), 'contributes.semanticTokenScopes must be declared');
    const mapped = (scopes as { scopes?: Record<string, string[]> }[])
      .map((entry) => entry.scopes?.['controlKeyword'])
      .find((entry) => entry !== undefined);
    assert.deepStrictEqual(
      mapped,
      ['keyword.control'],
      "'controlKeyword' must paint as the theme's keyword.control scope",
    );
  });

  test('F# control keywords keep the grammar colour no keyword token paints over', async function () {
    this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
    const { doc } = await openExistingFile(FIXTURE_DIR, path.join('fsharp', 'Library.fs'));
    const tokens = await paintedTokens(doc.uri);

    // FCS reports symbols, not keywords: `match`/`if`/`then`/`else` reach the
    // editor unpainted, so the F# grammar's keyword.control colour shows.
    const painted = paintedAt(doc, tokens, [
      ['match shape', 0],
      ['if value', 0],
      ['then Even', 0],
      ['else Odd', 0],
    ]);
    assert.deepStrictEqual(
      painted,
      {
        'match shape#0': undefined,
        'if value#0': undefined,
        'then Even#0': undefined,
        'else Odd#0': undefined,
      },
      'no semantic token flattens an F# control keyword into a plain keyword',
    );
    assert.ok(
      tokens.every((token) => token.type !== 'keyword'),
      `F# paints no plain keyword tokens at all: ${JSON.stringify(tokens.filter((t) => t.type === 'keyword'))}`,
    );
  });
});

suite('Standard language keyword scopes', () => {
  test('C# plain keywords use the standard language scope instead of the control-flow fallback', () => {
    // VS Code's default `keyword` fallback is `keyword.control`. Without a C#
    // mapping, declaration/type keywords become control-flow purple in Dark+.
    // [SHARPLSP-FEATURES-HIGHLIGHTING]
    const scopes: unknown = contributes().semanticTokenScopes;
    assert.ok(Array.isArray(scopes), 'semantic scope mappings exist');
    const entries = scopes as { language?: string; scopes?: Record<string, string[]> }[];
    const csharp = entries.find((entry) => entry.language === 'csharp');
    assert.ok(csharp, 'plain keyword mapping is scoped to C#, preserving F# grammar colors');
    assert.deepStrictEqual(csharp.scopes?.['keyword'], ['keyword.other.cs']);
    for (const language of ['razor', 'aspnetcorerazor']) {
      assert.deepStrictEqual(
        entries.find((entry) => entry.language === language)?.scopes?.['keyword'],
        ['keyword.other.cs'],
        `C# inside ${language} uses the same standard keyword scope`,
      );
    }
    assert.ok(!csharp.scopes?.['keyword']?.some((scope) => scope.startsWith('keyword.control')));
    const control = entries.find((entry) => entry.scopes?.['controlKeyword']);
    assert.deepStrictEqual(control?.scopes?.['controlKeyword'], ['keyword.control']);
    assert.ok(
      !entries.some((entry) => entry.language === 'fsharp' && entry.scopes?.['keyword']),
      'F# keyword coloring stays with its standard grammar',
    );
    const defaults: unknown = contributes().configurationDefaults;
    assert.ok(
      defaults === undefined || !JSON.stringify(defaults).includes('TokenColorCustomizations'),
      'the extension never hard-codes token colors over the selected theme',
    );
  });
});
