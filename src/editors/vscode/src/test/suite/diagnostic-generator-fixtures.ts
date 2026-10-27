// Real SDK generators exercise [DIAG-CATEGORIES-COMPILER] without mock compiler workspaces.
import * as fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { directoryOf, joinPath } from '../../paths';
import type { AccuracyFixture } from './diagnostic-accuracy-fixtures';
import { buildProjectXml, projectBuilder, writeProject } from './dotnet-project-kit';

const GENERATOR_SOURCE = String.raw`using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
[Generator]
public sealed class BrokenGenerator : IIncrementalGenerator {
    public void Initialize(IncrementalGeneratorInitializationContext context) {
        context.RegisterPostInitializationOutput(output => output.AddSource(
            "GeneratedBroken.g.cs", SourceText.From(
                "namespace GeneratedFailure { public static class Broken { public static int Value => \"bad\"; } }",
                Encoding.UTF8)));
    }
}
`;

interface ConsumerXml {
  Project: { ItemGroup: { ProjectReference: Record<string, string> } };
}

/** A genuine SDK analyzer assembly, built and loaded through ProjectReference metadata. */
export function writeCompilerGenerator(fixture: AccuracyFixture): void {
  writeProject(
    joinPath(fixture.root, 'Generator'),
    'Generator.csproj',
    buildProjectXml({
      properties: { TargetFramework: 'netstandard2.0', LangVersion: 'latest' },
      packages: [{ id: 'Microsoft.CodeAnalysis.CSharp', version: '4.14.0' }],
    }),
    'BrokenGenerator.cs',
    GENERATOR_SOURCE,
  );
}

/** Replace the whole project through the canonical XML AST and serializer. */
export function setCompilerGenerator(fixture: AccuracyFixture, enabled: boolean): string {
  const project = joinPath(directoryOf(fixture.entryUri.fsPath), fixture.scenario.project);
  const xml = buildProjectXml({
    projectReferences: enabled ? ['../Generator/Generator.csproj'] : [],
  });
  const document = new XMLParser({ ignoreAttributes: false }).parse(xml) as ConsumerXml;
  if (enabled) {
    document.Project.ItemGroup.ProjectReference.OutputItemType = 'Analyzer';
    document.Project.ItemGroup.ProjectReference.ReferenceOutputAssembly = 'false';
  }
  fs.writeFileSync(project, projectBuilder.build(document));
  return project;
}
