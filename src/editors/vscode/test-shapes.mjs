// Implements [DIST-CI-VSIX-SHARDS].
export function selectedWorkspaceShapes(requested) {
  const globs =
    requested
      ?.split(',')
      .map((glob) => glob.trim())
      .filter(Boolean) ?? [];
  if (globs.length === 0) return ['folder', 'multiroot'];
  const isMultiRootOnly = (glob) => glob.startsWith('multiroot/');
  const isRecursive = (glob) => glob.startsWith('**/');
  const folder = globs.some((glob) => !isMultiRootOnly(glob));
  const multiRoot = globs.some((glob) => isMultiRootOnly(glob) || isRecursive(glob));
  return [...(folder ? ['folder'] : []), ...(multiRoot ? ['multiroot'] : [])];
}
