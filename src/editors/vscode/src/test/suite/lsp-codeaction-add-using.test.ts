// Ctrl-. on a type that is missing its namespace import MUST offer the using.
//
// [SHARPLSP-FEATURES-REFACTORING] lists "Add using/open directive" as P0 with
// Roslyn's AddImport CodeFix behind it. That row is the single most-used
// interaction in day-to-day C#: the developer types a type name, the compiler
// reports it as unresolved, and the lightbulb must offer to import it.
//
// One syntactic position passing is not the feature. A type name can appear in
// a base list, a field declaration, a return type, a parameter, a generic
// argument, an attribute, or as the receiver of an extension method, and Ctrl-.
// has to work in EVERY one of them. Each row below is one of those positions;
// each drives the full lifecycle (offer, resolve, apply, requery, undo, redo,
// retry) and requires the diagnostic to DISAPPEAR after applying.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  codeOf,
  exerciseCodeAction,
  positionOf,
  rangeOf,
  rawCodeActions,
  type ActionLifecycleCase,
  type RawCodeAction,
} from './csharp-refactor-test-kit';
import {
  replaceDocumentText,
  waitForCodeActions,
  waitForMatchingDiagnostics,
  type OpenFixture,
  useRefactorFixture,
} from './refactor-test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

const HEADER = 'namespace SharpLsp.TestFixtures.AddUsing;\n';

/** A fixture whose ONLY error is the one missing import under test. */
function body(source: string): string {
  return HEADER + source;
}

const NEW_EXPRESSION = body(`public class NewExpressionTarget
{
    public object Make() { return new Stopwatch(); } // new-expression-sentinel
}
`);

const LOCAL_ANNOTATION = body(`public class LocalAnnotationTarget
{
    public object Make() { Regex pattern = null!; return pattern; } // local-annotation-sentinel
}
`);

const GENERIC_ARGUMENT = body(`public class GenericArgumentTarget
{
    public object Make() { return new List<int>(); } // generic-argument-sentinel
}
`);

const FIELD_DECLARATION = body(`public class FieldDeclarationTarget
{
    private Encoding _encoding = null!; // field-declaration-sentinel
    public object Read() => _encoding;
}
`);

const RETURN_TYPE = body(`public class ReturnTypeTarget
{
    public CultureInfo Culture() => null!; // return-type-sentinel
}
`);

const PARAMETER_TYPE = body(`public class ParameterTypeTarget
{
    public int Length(StringBuilder builder) => 0; // parameter-type-sentinel
}
`);

const BASE_TYPE = body(`public class BaseTypeTarget : EventArgs
{
    public int Value => 1; // base-type-sentinel
}
`);

const ATTRIBUTE_USAGE = body(`public class AttributeUsageTarget
{
    [Obsolete("retired")]
    public int Value => 1; // attribute-usage-sentinel
}
`);

const EXTENSION_METHOD = body(`public class ExtensionMethodTarget
{
    public object Project(int[] values) { return values.Select(value => value); } // extension-method-sentinel
}
`);

const STATIC_MEMBER = body(`public class StaticMemberTarget
{
    public object Read(string path) { return File.ReadAllText(path); } // static-member-sentinel
}
`);

/**
 * Every row shares the same contract: the position reports an unresolved-symbol
 * diagnostic, the lightbulb offers the exact using directive as a `quickfix`,
 * applying it inserts the directive, and the diagnostic is GONE afterwards.
 * `caretOnly` drives the literal user story - a bare caret on the type, no
 * selection, which is what Ctrl-. sends.
 */
/** One missing-using row, carrying only what varies between rows. */
interface MissingUsing {
  readonly label: string;
  readonly source: string;
  readonly snippet: string;
  readonly focus: string;
  /** The namespace the fix imports. */
  readonly namespace: string;
  /** The row's own marker, which must survive the edit. */
  readonly sentinel: string;
  /** The unresolved-symbol diagnostic; CS0246 unless the row says otherwise. */
  readonly code?: string;
  readonly alsoPresent?: readonly string[];
}

/** The row every case shares: the exact `using` as a caret-only quickfix that clears the error. */
function missingUsing(row: MissingUsing): ActionLifecycleCase {
  const title = `using ${row.namespace};`;
  return {
    label: row.label,
    source: row.source,
    snippet: row.snippet,
    focus: row.focus,
    diagnosticCode: row.code ?? 'CS0246',
    title,
    kind: 'quickfix',
    caretOnly: true,
    mustDisappear: true,
    presentAfter: [title, ...(row.alsoPresent ?? []), row.sentinel],
    absentAfter: [],
  };
}

const CASES: readonly ActionLifecycleCase[] = [
  missingUsing({
    label: 'object-creation type',
    source: NEW_EXPRESSION,
    snippet: 'new Stopwatch()',
    focus: 'Stopwatch',
    namespace: 'System.Diagnostics',
    sentinel: 'new-expression-sentinel',
    alsoPresent: ['new Stopwatch()'],
  }),
  missingUsing({
    label: 'local-variable type annotation',
    source: LOCAL_ANNOTATION,
    snippet: 'Regex pattern',
    focus: 'Regex',
    namespace: 'System.Text.RegularExpressions',
    sentinel: 'local-annotation-sentinel',
  }),
  missingUsing({
    label: 'generic type argument',
    source: GENERIC_ARGUMENT,
    snippet: 'new List<int>()',
    focus: 'List',
    namespace: 'System.Collections.Generic',
    sentinel: 'generic-argument-sentinel',
  }),
  missingUsing({
    label: 'field declaration type',
    source: FIELD_DECLARATION,
    snippet: 'private Encoding _encoding',
    focus: 'Encoding',
    namespace: 'System.Text',
    sentinel: 'field-declaration-sentinel',
  }),
  missingUsing({
    label: 'method return type',
    source: RETURN_TYPE,
    snippet: 'public CultureInfo Culture()',
    focus: 'CultureInfo',
    namespace: 'System.Globalization',
    sentinel: 'return-type-sentinel',
  }),
  missingUsing({
    label: 'method parameter type',
    source: PARAMETER_TYPE,
    snippet: 'Length(StringBuilder builder)',
    focus: 'StringBuilder',
    namespace: 'System.Text',
    sentinel: 'parameter-type-sentinel',
  }),
  missingUsing({
    label: 'base type in the class declaration',
    source: BASE_TYPE,
    snippet: 'BaseTypeTarget : EventArgs',
    focus: 'EventArgs',
    namespace: 'System',
    sentinel: 'base-type-sentinel',
  }),
  missingUsing({
    label: 'attribute usage',
    source: ATTRIBUTE_USAGE,
    snippet: '[Obsolete("retired")]',
    focus: 'Obsolete',
    namespace: 'System',
    sentinel: 'attribute-usage-sentinel',
  }),
  missingUsing({
    label: 'extension-method receiver',
    source: EXTENSION_METHOD,
    snippet: 'values.Select(value => value)',
    focus: 'Select',
    namespace: 'System.Linq',
    sentinel: 'extension-method-sentinel',
    code: 'CS1061',
  }),
  missingUsing({
    label: 'static member access on an unimported type',
    source: STATIC_MEMBER,
    snippet: 'File.ReadAllText(path)',
    focus: 'File',
    namespace: 'System.IO',
    sentinel: 'static-member-sentinel',
    code: 'CS0103',
  }),
];

const UNKNOWN_TYPE = body(`public class UnknownTypeTarget
{
    public object Make() { return new NoSuchTypeAnywhere(); } // unknown-type-sentinel
}
`);

const ALREADY_IMPORTED =
  'using System.Text;\n' +
  body(`public class AlreadyImportedTarget
{
    public object Make() { return new StringBuilder(); } // already-imported-sentinel
}
`);

const UNRESOLVED = 'CS0246';

function usingActions(actions: readonly RawCodeAction[]): RawCodeAction[] {
  return actions.filter((action) => action.title.startsWith('using '));
}

/** Ctrl-. sends a COLLAPSED caret, never a selection. Model that exactly. */
async function caretActions(
  fixture: OpenFixture,
  snippet: string,
  focus: string,
): Promise<RawCodeAction[]> {
  const caret = positionOf(fixture.document, snippet, focus);
  return rawCodeActions(fixture.uri, new vscode.Range(caret, caret));
}

suite('C# real LSP - Ctrl-. adds the missing using [SHARPLSP-FEATURES-REFACTORING]', () => {
  let fixture: OpenFixture;
  let committedText = '';

  const refactor = useRefactorFixture('RefactorCore.cs');
  setup(() => {
    ({ fixture, committedText } = refactor());
  });

  for (const actionCase of CASES) {
    const label = `${actionCase.label}: Ctrl-. offers ${actionCase.title} and clears ${actionCase.diagnosticCode}`;
    test(label, async function () {
      this.timeout(LSP_RESPONSE_MS + 5_000);
      await exerciseCodeAction(fixture, committedText, actionCase);
    });
  }

  test('the import is the PREFERRED action, so Ctrl-. lands on it first', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    await replaceDocumentText(fixture.document, NEW_EXPRESSION);

    // Interaction 1 - the developer types the unimported type and the compiler
    // reports it. Without the diagnostic there is nothing for Ctrl-. to fix.
    const before = await waitForMatchingDiagnostics(fixture.uri, (items) =>
      items.some((item) => codeOf(item) === UNRESOLVED),
    );
    const unresolved = before.filter((item) => codeOf(item) === UNRESOLVED);
    assert.strictEqual(unresolved.length, 1, 'exactly one unresolved-type error');
    assert.strictEqual(unresolved[0]?.severity, vscode.DiagnosticSeverity.Error, 'it is an error');
    assert.ok(
      unresolved[0]?.message.includes('Stopwatch'),
      'and the message names the type the developer just typed',
    );

    // Interaction 2 - the caret goes on the type name, nothing is selected, and
    // Ctrl-. is pressed. The import must be offered, and offered FIRST: an
    // import buried under "Generate class Stopwatch" is a broken lightbulb.
    const offered = await caretActions(fixture, 'new Stopwatch()', 'Stopwatch');
    const imports = usingActions(offered);
    assert.strictEqual(imports.length, 1, 'exactly one using directive is offered');
    assert.strictEqual(imports[0]?.title, 'using System.Diagnostics;', 'naming the namespace');
    assert.strictEqual(imports[0]?.kind, 'quickfix', 'as a quickfix, not a refactoring');
    assert.strictEqual(
      imports[0]?.isPreferred,
      true,
      'and marked preferred so Ctrl-. ranks it top',
    );
    assert.strictEqual(
      offered.indexOf(imports[0]),
      0,
      'a preferred import must be the first action in the list',
    );

    // Interaction 3 - the same request through VS Code's own provider, because
    // the lightbulb the developer actually sees is the editor's, not the wire's.
    const uiActions = await waitForCodeActions({
      uri: fixture.uri,
      range: rangeOf(fixture.document, 'new Stopwatch()', 'Stopwatch'),
      kind: vscode.CodeActionKind.QuickFix,
      predicate: (items) => items.some((item) => item.title === 'using System.Diagnostics;'),
    });
    const uiImport = uiActions.find((item) => item.title === 'using System.Diagnostics;');
    assert.ok(uiImport, 'VS Code offers the import the protocol offered');
    assert.strictEqual(uiImport.isPreferred, true, 'and carries the preferred flag through');
    assert.ok(
      uiImport.kind?.contains(vscode.CodeActionKind.QuickFix),
      'under the quickfix kind the lightbulb filters on',
    );
    assert.ok(
      uiActions.every((item) => item.title !== 'using System.Diagnostics'),
      'the title is the directive verbatim, semicolon included',
    );
  });

  test('a type that exists in no namespace offers no import at all', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    await replaceDocumentText(fixture.document, UNKNOWN_TYPE);

    // Interaction 1 - an unresolvable name still reports CS0246; the import fix
    // must not invent a namespace for a type no assembly contains. The wait
    // names the type: the previous scenario's CS0246 can still be published
    // for the text this one replaced.
    const diagnostics = await waitForMatchingDiagnostics(fixture.uri, (items) =>
      items.some(
        (item) => codeOf(item) === UNRESOLVED && item.message.includes('NoSuchTypeAnywhere'),
      ),
    );
    assert.ok(diagnostics.length >= 1, 'the unresolvable type is reported');
    assert.ok(
      diagnostics.some((item) => item.message.includes('NoSuchTypeAnywhere')),
      'and the message names it',
    );

    // Interaction 2 - Ctrl-. on it may offer generation, but never a fabricated
    // import: a using for a namespace that does not exist compiles to nothing.
    const offered = await caretActions(fixture, 'new NoSuchTypeAnywhere()', 'NoSuchTypeAnywhere');
    assert.deepStrictEqual(usingActions(offered), [], 'no using directive is offered');
    assert.ok(
      offered.every((action) => !action.title.includes('NoSuchTypeAnywhere;')),
      'and nothing pretends the name is a namespace',
    );
    assert.ok(
      !fixture.document.getText().includes('using NoSuchTypeAnywhere'),
      'the buffer gains no invented directive',
    );
  });

  test('a type whose namespace is already imported offers no second import', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    await replaceDocumentText(fixture.document, ALREADY_IMPORTED);

    // Interaction 1 - with the using present the type resolves, so there is no
    // unresolved-symbol error left to fix.
    const diagnostics = await waitForMatchingDiagnostics(
      fixture.uri,
      (items) => !items.some((item) => codeOf(item) === UNRESOLVED),
    );
    assert.ok(
      diagnostics.every((item) => codeOf(item) !== UNRESOLVED),
      'an imported type reports no unresolved-type error',
    );
    assert.ok(
      fixture.document.getText().includes('using System.Text;'),
      'because the directive is already in the buffer',
    );

    // Interaction 2 - Ctrl-. on the resolved type must not offer to import it
    // a second time; a duplicate directive is a compile error of its own.
    const offered = await caretActions(fixture, 'new StringBuilder()', 'StringBuilder');
    assert.deepStrictEqual(
      usingActions(offered).map((action) => action.title),
      [],
      'no redundant import is offered for an already-imported type',
    );
    assert.strictEqual(
      fixture.document.getText().split('using System.Text;').length - 1,
      1,
      'and the buffer still carries exactly one such directive',
    );
  });
});
