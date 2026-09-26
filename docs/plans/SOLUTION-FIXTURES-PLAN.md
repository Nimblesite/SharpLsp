# Buildable Fixture Solutions Plan ([SE-ACTIONS-BUILD-FIXTURES])

Spec: [SE-ACTIONS-BUILD-FIXTURES](../specs/SOLUTION-EXPLORER-SPEC.md).
Bug: [#273](https://github.com/Nimblesite/SharpLsp/issues/273).

The `.sln` had no solution or project configurations. SDK 10.0.303 returned exit
zero and "Build succeeded" while warning "Unable to find a project to restore!"
and producing no assembly. This defect also exists at the release baseline
`7c3b1ce68cd7a4df8b95973b828c80c4335daa2c`; it is not a new regression.

## Verification

- [x] Add a regression that copies the real fixtures without build outputs and
  asserts all three nonempty F#/C# assemblies, plus no empty-restore warning.
- [x] Observe the original `.sln` Debug case fail specifically on the missing
  `FSharpFixtures.dll` after `dotnet build` falsely reported success.
- [x] Add Debug/Release solution and project mappings without changing the test.
- [x] Pass all four format/configuration cases using SDK 10.0.303 on macOS (9s).
- [x] Register the regression in the workspace chunk for both Linux and Windows.
- [ ] Pass the combined PR's Linux and Windows workspace chunks.
