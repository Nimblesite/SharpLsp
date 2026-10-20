// Implements [TUTORIAL-STEPS]: the step table, the only place that names a film.
import type { TutorialAction, TutorialLanguage, TutorialStep } from './model.generated.js';

export type LanguageKind = TutorialLanguage['kind'];
export type ActionKind = TutorialAction['kind'];

/** The taught languages, F# first ([TUTORIAL-GOAL]). */
export const LANGUAGES: readonly LanguageKind[] = ['FSharp', 'CSharp'];

/** Each language's steps, in walkthrough order. */
export const ACTIONS: readonly ActionKind[] = [
  'OpenFile',
  'Hover',
  'Completion',
  'Definition',
  'References',
  'SolutionExplorer',
];

/** Where the website publishes its films ([TUTORIAL-PANEL]). */
export const FILM_ORIGIN = 'https://sharplsp.dev';

/** Films the website publishes without an English caption track. */
const UNCAPTIONED_FILMS: ReadonlySet<string> = new Set(['sharplsp-tour']);

interface LanguageFacts {
  /** VS Code's language id. */
  readonly id: string;
  readonly label: string;
  /** The workspace glob `sharplsp.tutorial.openFile` searches. */
  readonly sourceGlob: string;
  readonly openFileFilm: string;
}

const LANGUAGE_FACTS: Record<LanguageKind, LanguageFacts> = {
  FSharp: { id: 'fsharp', label: 'F#', sourceGlob: '**/*.fs', openFileFilm: 'fsharp-language' },
  CSharp: { id: 'csharp', label: 'C#', sourceGlob: '**/*.cs', openFileFilm: 'getting-started' },
};

interface ActionFacts {
  /** The LSP request whose meaningful response ticks the step ([TUTORIAL-DETECT-LSP]). */
  readonly method?: string;
  /** The film; `undefined` means the language's own `openFileFilm`. */
  readonly film?: string;
  readonly title: (language: string) => string;
  readonly instruction: (language: string) => string;
}

const ACTION_FACTS: Record<ActionKind, ActionFacts> = {
  OpenFile: {
    title: (l) => `Open an ${l} file`,
    instruction: (l) => `Open any ${l} source file in the editor.`,
  },
  Hover: {
    method: 'textDocument/hover',
    film: 'hover',
    title: () => 'Hover a symbol',
    instruction: (l) => `Rest the mouse on a function, type or value in the ${l} file.`,
  },
  Completion: {
    method: 'textDocument/completion',
    film: 'code-completions',
    title: () => 'Complete code',
    instruction: () => 'Type a dot after a value, or press Ctrl+Space, and pick an item.',
  },
  Definition: {
    method: 'textDocument/definition',
    film: 'navigation',
    title: () => 'Go to a definition',
    instruction: () => 'Put the caret on a symbol and press F12.',
  },
  References: {
    method: 'textDocument/references',
    film: 'navigation',
    title: () => 'Find all references',
    instruction: () => 'Put the caret on a symbol and press Shift+F12.',
  },
  SolutionExplorer: {
    film: 'sharplsp-tour',
    title: () => 'Open the Solution Explorer',
    instruction: () => 'Click the SharpLsp icon in the activity bar.',
  },
};

export function stepOf(language: LanguageKind, action: ActionKind): TutorialStep {
  return { language: { kind: language }, action: { kind: action } };
}

/** `FSharp.Hover`: a step's identity, stable across sessions. */
export function stepKey(step: TutorialStep): string {
  return `${step.language.kind}.${step.action.kind}`;
}

/** The context key the walkthrough completes on ([TUTORIAL-WALKTHROUGH]). */
export function contextKey(step: TutorialStep): string {
  return `sharplsp.tutorial.${stepKey(step)}`;
}

export function stepsOf(language: LanguageKind): readonly TutorialStep[] {
  return ACTIONS.map((action) => stepOf(language, action));
}

export const ALL_STEPS: readonly TutorialStep[] = LANGUAGES.flatMap(stepsOf);

export function languageOfId(languageId: string): LanguageKind | undefined {
  return LANGUAGES.find((language) => LANGUAGE_FACTS[language].id === languageId);
}

export function actionOfMethod(method: string): ActionKind | undefined {
  return ACTIONS.find((action) => ACTION_FACTS[action].method === method);
}

export function languageLabel(language: LanguageKind): string {
  return LANGUAGE_FACTS[language].label;
}

export function sourceGlob(language: LanguageKind): string {
  return LANGUAGE_FACTS[language].sourceGlob;
}

export function titleOf(step: TutorialStep): string {
  return ACTION_FACTS[step.action.kind].title(languageLabel(step.language.kind));
}

export function instructionOf(step: TutorialStep): string {
  return ACTION_FACTS[step.action.kind].instruction(languageLabel(step.language.kind));
}

export interface Film {
  readonly webm: string;
  readonly poster: string;
  /** `null` when the film has no English captions. */
  readonly captions: string | null;
}

export function filmOf(step: TutorialStep): Film {
  const name =
    ACTION_FACTS[step.action.kind].film ?? LANGUAGE_FACTS[step.language.kind].openFileFilm;
  const base = `${FILM_ORIGIN}/assets/videos/${name}`;
  const captions = UNCAPTIONED_FILMS.has(name) ? null : `${base}.en.vtt`;
  return { webm: `${base}.webm`, poster: `${base}-poster.webp`, captions };
}
