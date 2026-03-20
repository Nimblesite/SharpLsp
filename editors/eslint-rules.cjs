/**
 * Shared ESLint rules for all Forge editor extensions.
 *
 * These are the master type-safety and correctness rules that every
 * TypeScript extension in the Forge project must obey.
 */

/** @type {import('eslint').Linter.RulesRecord} */
const masterRules = {
  // ── 1. No implicit any — every value must have a known type ────────
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',

  // ── 2. Strict null checks — no accidental undefined access ─────────
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/strict-boolean-expressions': ['error', {
    allowNullableBoolean: false,
    allowNullableString: false,
    allowNullableNumber: false,
    allowNullableObject: false,
    allowAny: false,
  }],

  // ── 3. Exhaustive switches — catch missing enum cases at lint time ─
  '@typescript-eslint/switch-exhaustiveness-check': 'error',

  // ── 4. No floating promises — every async call must be awaited ─────
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  'no-void': ['error', { allowAsStatement: true }],

  // ── 5. No unused variables — dead code is a bug vector ─────────────
  '@typescript-eslint/no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],

  // ── 6. Prefer const — immutability by default ──────────────────────
  'prefer-const': 'error',

  // ── 7. Explicit return types — public API contracts must be clear ───
  '@typescript-eslint/explicit-function-return-type': ['error', {
    allowExpressions: true,
    allowTypedFunctionExpressions: true,
    allowHigherOrderFunctions: true,
  }],

  // ── 8. No shadow — inner vars must not hide outer vars ─────────────
  '@typescript-eslint/no-shadow': 'error',
  'no-shadow': 'off', // use TS version instead

  // ── 9. Consistent type imports — enforce `import type` ─────────────
  '@typescript-eslint/consistent-type-imports': ['error', {
    prefer: 'type-imports',
    fixStyle: 'inline-type-imports',
  }],

  // ── 10. No require — ESM only ─────────────────────────────────────
  '@typescript-eslint/no-require-imports': 'error',

  // ── Bonus: tighten equality ────────────────────────────────────────
  'eqeqeq': ['error', 'always'],
  'no-param-reassign': 'error',
};

/** Relaxed overrides for test files. */
/** @type {import('eslint').Linter.RulesRecord} */
const testOverrides = {
  // Tests may use non-null assertions for test setup.
  '@typescript-eslint/no-non-null-assertion': 'off',
  // Tests may have longer files.
  'max-lines': 'off',
  // Test assertions may use any.
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  // Tests may use explicit any for mocks.
  '@typescript-eslint/no-explicit-any': 'off',
  // Tests may not need return types.
  '@typescript-eslint/explicit-function-return-type': 'off',
  // Tests may have looser boolean expressions.
  '@typescript-eslint/strict-boolean-expressions': 'off',
  // Test files can be longer and have more params.
  'max-params': 'off',
  // Tests don't need readonly parameter enforcement.
  '@typescript-eslint/prefer-readonly-parameter-types': 'off',
};

module.exports = { masterRules, testOverrides };
