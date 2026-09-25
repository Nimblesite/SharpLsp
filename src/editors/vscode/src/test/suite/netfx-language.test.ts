// [NETFX-CONTEXT] for C#: a project built for net462, net472, net48,
// netstandard2.0, netstandard2.1 and .NET, which MSBuildWorkspace loads as one
// Roslyn project per framework, answering from the ACTIVE one. The whole
// contract lives in netfx-language-suite.ts, shared with F#.
//
// Covers [NETFX-PROJECTS-CSHARP] and [NETFX-CONTEXT].
import { defineNetfxLanguageSuite } from './netfx-language-suite';

defineNetfxLanguageSuite(
  'csharp',
  '.NET Framework language — C# across three .NET Framework, two .NET Standard and .NET',
);
