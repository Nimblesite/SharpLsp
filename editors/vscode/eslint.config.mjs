import tseslint from 'typescript-eslint';
import eslint from '@eslint/js';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Source files — max type safety
    files: ['src/**/*.ts'],
    ignores: ['src/test/**/*.ts'],
    rules: {
      // ── 1. No implicit any — every value must have a known type ────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // ── 2. Strict null checks — no accidental undefined ────────────
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/strict-boolean-expressions': ['error', {
        allowNullableBoolean: false,
        allowNullableString: false,
        allowNullableNumber: false,
        allowNullableObject: false,
        allowAny: false,
      }],

      // ── 3. Exhaustive switches — catch missing enum cases ──────────
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // ── 4. No floating promises — every async call awaited ─────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-void': ['error', { allowAsStatement: true }],

      // ── 5. No unused variables — dead code is a bug vector ─────────
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // ── 6. Prefer const — immutability by default ──────────────────
      'prefer-const': 'error',

      // ── 7. Explicit return types — contracts must be clear ─────────
      '@typescript-eslint/explicit-function-return-type': ['error', {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      }],

      // ── 8. No shadow — inner vars must not hide outer vars ─────────
      '@typescript-eslint/no-shadow': 'error',
      'no-shadow': 'off',

      // ── 9. Consistent type imports — enforce `import type` ─────────
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      }],

      // ── 10. No require — ESM only ─────────────────────────────────
      '@typescript-eslint/no-require-imports': 'error',

      // ── 11. Immutable fields — never-reassigned privates must be readonly ─
      '@typescript-eslint/prefer-readonly': 'error',

      // ── 12. Safe sort — Array.sort() without comparator is a bug ────────
      '@typescript-eslint/require-array-sort-compare': 'error',

      // ── 13. Async consistency — promise-returning functions must be async ─
      '@typescript-eslint/promise-function-async': 'error',

      // ── 14. Explicit visibility — no implicit public on class members ────
      '@typescript-eslint/explicit-member-accessibility': ['error', {
        accessibility: 'explicit',
        overrides: { constructors: 'no-public' },
      }],

      // ── 15. No deprecated — flag usage of deprecated APIs immediately ────
      '@typescript-eslint/no-deprecated': 'error',

      // ── 16. No type assertions — casting is illegal ─────────────────
      '@typescript-eslint/consistent-type-assertions': ['error', {
        assertionStyle: 'never',
      }],

      // Conflicts with no-non-null-assertion — disable the weaker rule.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',

      // ── Bonus rules ────────────────────────────────────────────────
      'eqeqeq': ['error', 'always'],
      'no-param-reassign': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },
  {
    // Test files — relaxed
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    ignores: ['out/', 'dist/', 'coverage/', 'node_modules/', '*.mjs', '*.cjs', '*.js'],
  },
);
