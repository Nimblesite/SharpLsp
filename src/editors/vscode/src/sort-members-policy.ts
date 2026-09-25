// The member order the `sharplsp.memberSortOrder` settings default to, shared
// by the Sort Members command and the suites that configure it.
// Implements [SE-CONTEXT-SORT-SETTINGS].

export const DEFAULT_SORT_POLICY = {
  hierarchy: ['accessibility', 'category', 'alphabetical'],
  accessibilityOrder: [
    'public',
    'protected internal',
    'internal',
    'protected',
    'private protected',
    'private',
  ],
  categoryOrder: [
    'constant',
    'field',
    'constructor',
    'finalizer',
    'delegate',
    'event',
    'enum',
    'interface',
    'property',
    'indexer',
    'operator',
    'method',
    'struct',
    'class',
    'record',
  ],
} as const;
