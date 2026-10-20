// Implements [TUTORIAL-PANEL]: what the video panel shows, as a pure projection of progress.
import type { TutorialProgress } from './model.generated.js';
import { currentStep, isDone } from './progress.js';
import {
  type Film,
  filmOf,
  instructionOf,
  LANGUAGES,
  type LanguageKind,
  languageLabel,
  stepKey,
  stepsOf,
  titleOf,
} from './steps.js';

export interface LanguageView {
  readonly kind: LanguageKind;
  readonly label: string;
  readonly selected: boolean;
  readonly done: number;
  readonly total: number;
}

export interface StepView {
  readonly key: string;
  readonly title: string;
  readonly done: boolean;
  readonly current: boolean;
}

export interface CurrentView {
  readonly key: string;
  readonly title: string;
  readonly instruction: string;
  readonly film: Film;
  /** The step offers "Open one for me" ([TUTORIAL-WALKTHROUGH]). */
  readonly opensFile: boolean;
}

export interface PanelView {
  readonly language: LanguageKind;
  readonly languages: readonly LanguageView[];
  readonly steps: readonly StepView[];
  /** `null` once every step of the language is done. */
  readonly current: CurrentView | null;
}

function languageView(
  progress: TutorialProgress,
  kind: LanguageKind,
  selected: LanguageKind,
): LanguageView {
  const steps = stepsOf(kind);
  const done = steps.filter((step) => isDone(progress, step)).length;
  return {
    kind,
    label: languageLabel(kind),
    selected: kind === selected,
    done,
    total: steps.length,
  };
}

function currentView(progress: TutorialProgress, language: LanguageKind): CurrentView | null {
  const step = currentStep(progress, language);
  if (step === undefined) return null;
  return {
    key: stepKey(step),
    title: titleOf(step),
    instruction: instructionOf(step),
    film: filmOf(step),
    opensFile: step.action.kind === 'OpenFile',
  };
}

export function panelView(progress: TutorialProgress, language: LanguageKind): PanelView {
  const current = currentView(progress, language);
  const steps = stepsOf(language).map((step) => ({
    key: stepKey(step),
    title: titleOf(step),
    done: isDone(progress, step),
    current: current?.key === stepKey(step),
  }));
  const languages = LANGUAGES.map((kind) => languageView(progress, kind, language));
  return { language, languages, steps, current };
}
