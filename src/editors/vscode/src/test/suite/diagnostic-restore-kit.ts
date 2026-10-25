// Observe actual SDK restoration without product instrumentation. [DIAG-RESTORE]
import * as fs from 'node:fs';
import { joinPath } from '../../paths';
import { projectBuilder } from './dotnet-project-kit';

const RESTORE_TARGET = {
  Project: {
    Target: {
      '@_Name': 'ObserveWorkspaceRestore',
      '@_BeforeTargets': 'Restore',
      WriteLinesToFile: {
        '@_File': '$(MSBuildThisFileDirectory)restore-ran.txt',
        '@_Lines': '$(MSBuildProjectFullPath)',
        '@_Overwrite': 'True',
      },
    },
  },
};

/** Observe the real Restore target without any product instrumentation. */
export function writeRestoreMarker(root: string): string {
  const marker = joinPath(root, 'restore-ran.txt');
  fs.writeFileSync(joinPath(root, 'Directory.Build.targets'), projectBuilder.build(RESTORE_TARGET));
  return marker;
}
