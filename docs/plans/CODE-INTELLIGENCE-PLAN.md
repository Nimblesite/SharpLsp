# Code Intelligence Plan

Remaining code intelligence features not covered by other plans.

## Signature Help

- [ ] Implement `textDocument/signatureHelp` handler in Rust host
- [ ] Wire C# sidecar to Roslyn `SignatureHelpService`
- [ ] Wire F# sidecar to FCS signature help
- [ ] Register `signatureHelpProvider` in server capabilities
- [ ] E2E test: signature help on method call returns parameter info

## Rename

- [ ] Implement `textDocument/rename` handler in Rust host
- [ ] Implement `textDocument/prepareRename` handler
- [ ] Wire C# sidecar to Roslyn `Renamer.RenameSymbolAsync`
- [ ] Wire F# sidecar to FCS rename
- [ ] Register `renameProvider` in server capabilities
- [ ] E2E test: rename symbol across files

## Editor Navigation

- [ ] Breadcrumb / scope bar support (documentSymbol hierarchy)
- [ ] Go to related files (e.g. .cs <-> .designer.cs, interface <-> implementation)
- [ ] Structural navigation (next/prev member)

## Misc

- [ ] Regex syntax highlighting in string literals
