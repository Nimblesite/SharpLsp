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
  'CodeAction',
  'SolutionExplorer',
];

/** Where the website publishes its films ([TUTORIAL-PANEL]). */
export const FILM_ORIGIN = 'https://sharplsp.dev';

/** The commit whose website assets hold films the site has not deployed yet. */
const FILM_COMMIT = '8b0fa431ce701d73af897192247305864e216dd9';
const FILM_PATH = `Nimblesite/SharpLsp/${FILM_COMMIT}/src/website/src/assets/videos`;
/** GitHub serves a film's LFS WebM from one host, and its poster and captions from another. */
const GITHUB_MEDIA = 'https://media.githubusercontent.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';

/** Every origin a film, its poster or its captions load from: the panel's policy allows these only. */
export const FILM_ORIGINS: readonly string[] = [FILM_ORIGIN, GITHUB_MEDIA, GITHUB_RAW];

/** Films still waiting for the site to deploy: GitHub serves them from `FILM_COMMIT` until then. */
const UNDEPLOYED_FILMS: ReadonlySet<string> = new Set(['refactoring-lesson']);

/** Films the website publishes without an English caption track. */
const UNCAPTIONED_FILMS: ReadonlySet<string> = new Set(['sharplsp-tour']);

interface LanguageFacts {
  /** VS Code's language id. */
  readonly id: string;
  readonly label: string;
  /** The indefinite article before the label: "an F# file", "a C# file". */
  readonly article: 'a' | 'an';
  /** The workspace glob `sharplsp.tutorial.openFile` searches. */
  readonly sourceGlob: string;
  readonly openFileFilm: string;
}

const LANGUAGE_FACTS: Record<LanguageKind, LanguageFacts> = {
  FSharp: {
    id: 'fsharp',
    label: 'F#',
    article: 'an',
    sourceGlob: '**/*.fs',
    openFileFilm: 'fsharp-language',
  },
  CSharp: {
    id: 'csharp',
    label: 'C#',
    article: 'a',
    sourceGlob: '**/*.cs',
    openFileFilm: 'getting-started',
  },
};

interface ActionFacts {
  /** The LSP request whose meaningful response ticks the step ([TUTORIAL-DETECT-LSP]). */
  readonly method?: string;
  /** The film; `undefined` means the language's own `openFileFilm`. */
  readonly film?: string;
  /** Seconds into the film where each language's chapter starts; `undefined` plays from 0. */
  readonly filmStart?: Readonly<Record<LanguageKind, number>>;
  readonly title: (language: LanguageFacts) => string;
  readonly instruction: (language: LanguageFacts) => string;
}

const ACTION_FACTS: Record<ActionKind, ActionFacts> = {
  OpenFile: {
    title: (l) => `Open ${l.article} ${l.label} file`,
    instruction: (l) => `Open any ${l.label} source file in the editor.`,
  },
  Hover: {
    method: 'textDocument/hover',
    film: 'hover',
    title: () => 'Hover a symbol',
    instruction: (l) => `Rest the mouse on a function, type or value in the ${l.label} file.`,
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
  CodeAction: {
    method: 'textDocument/codeAction',
    // The FilmMakers' lesson: F# quick fixes at 0:44, C# generate method at 1:56.
    film: 'refactoring-lesson',
    filmStart: { FSharp: 44, CSharp: 116 },
    title: () => 'Fix code with a code action',
    instruction: () =>
      'Put the caret on a warning or error, press Cmd+. (Ctrl+. on Windows and Linux), and pick a fix.',
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
  return ACTION_FACTS[step.action.kind].title(LANGUAGE_FACTS[step.language.kind]);
}

export function instructionOf(step: TutorialStep): string {
  return ACTION_FACTS[step.action.kind].instruction(LANGUAGE_FACTS[step.language.kind]);
}

export interface Film {
  readonly webm: string;
  readonly poster: string;
  /** `null` when the film has no English captions. */
  readonly captions: string | null;
  /** Seconds into the film where the step's chapter starts. */
  readonly start: number;
}

/** Where a film's WebM and its other assets live: the website, or GitHub until it deploys. */
function filmBases(name: string): { readonly video: string; readonly assets: string } {
  if (!UNDEPLOYED_FILMS.has(name)) {
    const site = `${FILM_ORIGIN}/assets/videos/${name}`;
    return { video: site, assets: site };
  }
  return {
    video: `${GITHUB_MEDIA}/media/${FILM_PATH}/${name}`,
    assets: `${GITHUB_RAW}/${FILM_PATH}/${name}`,
  };
}

export function filmOf(step: TutorialStep): Film {
  const facts = ACTION_FACTS[step.action.kind];
  const name = facts.film ?? LANGUAGE_FACTS[step.language.kind].openFileFilm;
  const { video, assets } = filmBases(name);
  const captions = UNCAPTIONED_FILMS.has(name) ? null : `${assets}.en.vtt`;
  const start = facts.filmStart?.[step.language.kind] ?? 0;
  return { webm: `${video}.webm`, poster: `${assets}-poster.webp`, captions, start };
}
