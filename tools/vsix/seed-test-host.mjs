// Implements [DIST-CI-VSIX-HOST-CACHE]: download exactly the host the test config
// asks for, under the config's own connection settings, into `.vscode-test`, with
// the extension SharpLsp depends on already installed so the cache carries it.
await import("./install-test-dependency.mjs");
