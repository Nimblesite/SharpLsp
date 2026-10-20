// Implements [TUTORIAL-PROGRESS]: the single source of truth for what the user has done.
import { Signal } from '../signals.js';
import { isRecord } from '../utils.js';
import type { TutorialProgress, TutorialStep } from './model.generated.js';
import { ACTIONS, ALL_STEPS, LANGUAGES, type LanguageKind, stepKey, stepsOf } from './steps.js';

export const EMPTY_PROGRESS: TutorialProgress = { done: [] };

export function isDone(progress: TutorialProgress, step: TutorialStep): boolean {
  const key = stepKey(step);
  return progress.done.some((done) => stepKey(done) === key);
}

/** `progress` with `step` done; the SAME object when it already was, so no one is notified. */
export function withStep(progress: TutorialProgress, step: TutorialStep): TutorialProgress {
  return isDone(progress, step) ? progress : { done: [...progress.done, step] };
}

/** The language's first step not yet done, or `undefined` once all are. */
export function currentStep(
  progress: TutorialProgress,
  language: LanguageKind,
): TutorialStep | undefined {
  return stepsOf(language).find((step) => !isDone(progress, step));
}

/** Whether a stored value is a progress this version understands. */
export function isTutorialProgress(value: unknown): value is TutorialProgress {
  return isRecord(value) && Array.isArray(value.done) && value.done.every(isKnownStep);
}

function isKnownStep(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.language) || !isRecord(value.action)) return false;
  const { language, action } = value;
  return (
    LANGUAGES.some((kind) => kind === language.kind) && ACTIONS.some((kind) => kind === action.kind)
  );
}

/** Every step, paired with whether it is done: what the context keys mirror. */
export function stepStates(
  progress: TutorialProgress,
): readonly { readonly step: TutorialStep; readonly done: boolean }[] {
  return ALL_STEPS.map((step) => ({ step, done: isDone(progress, step) }));
}

/** The live progress. Written only through `record` and `resetProgress`. */
export const progress = new Signal<TutorialProgress>(EMPTY_PROGRESS);

export function record(step: TutorialStep): void {
  progress.value = withStep(progress.value, step);
}

export function resetProgress(): void {
  progress.value = EMPTY_PROGRESS;
}
