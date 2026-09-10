// Real non-user library for [CONFIG-DEBUG-EXCEPTIONS]. No PDB is distributed.
import * as path from 'node:path';
import { buildProjectXml, writeProject } from './dotnet-project-kit';

/** Three physical frames, with a handler below the library's public entry. */
const SOURCE = `
using System;
using System.Diagnostics;
using System.Runtime.CompilerServices;

[DebuggerNonUserCode]
public static class ExternalExceptions {
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static int Recover() => CatchBelow();

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int CatchBelow() {
        try { return ThrowDeep(); }
        catch (InvalidOperationException) {
            Console.WriteLine("library-handled");
            return 42;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int ThrowDeep() => throw new InvalidOperationException("library-internal");
}
`;

/** Write the same library once per existing debug fixture, returning a project reference. */
export function writeExceptionLibrary(appDirectory: string): string {
  const project = path.join('..', 'ExternalExceptions', 'ExternalExceptions.csproj');
  writeProject(
    path.dirname(path.resolve(appDirectory, project)),
    'ExternalExceptions.csproj',
    buildProjectXml({
      properties: {
        DebugType: 'none',
        DebugSymbols: 'false',
        Optimize: 'false',
        EnableNETAnalyzers: 'false',
        RunAnalyzersDuringBuild: 'false',
      },
    }),
    'Library.cs',
    SOURCE,
  );
  return project;
}
