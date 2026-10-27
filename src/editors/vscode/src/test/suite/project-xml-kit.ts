// Reading a project file the way MSBuild does, as XML, never by matching its text.
// Supports [SE-ADD-FILE-ORDER] and [SE-ADD-FILE-CSHARP] assertions.
import * as fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

/** Every `ItemGroup` and `Compile` as an array, so one item and many read alike. */
const projectParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'Compile' || name === 'ItemGroup',
});

/** The `Include` of every `Compile` item in `projectPath`, in document order. */
export function compileIncludes(projectPath: string): string[] {
  const doc = projectParser.parse(fs.readFileSync(projectPath, 'utf-8')) as {
    Project?: { ItemGroup?: { Compile?: { '@_Include'?: string }[] }[] };
  };
  return (doc.Project?.ItemGroup ?? []).flatMap((group) =>
    (group.Compile ?? []).flatMap((item) => item['@_Include'] ?? []),
  );
}
