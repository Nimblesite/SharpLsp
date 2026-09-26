// [NETFX-CONTEXT] for F#, first: a project built for net462, net472, net48,
// netstandard2.0, netstandard2.1 and .NET, whose FCS options must come from
// MSBuild's design-time compile per framework — never from the sidecar's own
// runtime. The whole contract lives in netfx-language-suite.ts, shared with C#.
//
// Covers [NETFX-PROJECTS-FSHARP] and [NETFX-CONTEXT].
import { defineNetfxLanguageSuite } from './netfx-language-suite';

defineNetfxLanguageSuite(
  'fsharp',
  '.NET Framework language — F# across three .NET Framework, two .NET Standard and .NET',
);
