const { masterRules, testOverrides } = require('../eslint-rules.cjs');

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  ignorePatterns: ['out/', 'coverage/', '.eslintrc.js', 'scripts/', 'playwright.config.ts'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/strict-type-checked',
    'plugin:@typescript-eslint/stylistic-type-checked',
  ],
  rules: {
    ...masterRules,
    // Project-specific: VSIX uses interfaces for VSCode API compat
    '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    // Project-specific: VSIX uses function declarations for hoisting
    'func-style': ['error', 'declaration'],
    // Project-specific: VSIX enforces tighter limits
    'max-lines': ['error', 300],
    'max-params': ['error', 3],
    // Project-specific: class methods that implement TreeDataProvider
    'class-methods-use-this': ['error', { exceptMethods: ['getTreeItem'] }],
    // Project-specific: enforce readonly parameters with VSIX-specific allow list
    '@typescript-eslint/prefer-readonly-parameter-types': ['error', {
      treatMethodsAsReadonly: true,
      allow: [
        'AbortController',
        'AbortSignal',
        'AgentTreeItem',
        'AgentsTreeProvider',
        'Buffer',
        'ChildProcess',
        'Error',
        'ExtensionContext',
        'LockTreeItem',
        'LocksTreeProvider',
        'MarkdownString',
        'MessageTreeItem',
        'MessagesTreeProvider',
        'ReadableStream',
        'ReadableStreamDefaultReader',
        'ReadableStreamReadResult',
        'Response',
        'StoreManager',
        'TreeItem',
        'Uint8Array',
        'WebviewPanel',
      ],
    }],
  },
  overrides: [
    {
      files: ['*.test.ts', '*.spec.ts'],
      rules: testOverrides,
    },
  ],
};
