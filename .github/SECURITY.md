# Security Policy

## Supported versions

SharpLsp is pre-1.0 and ships from a single active line. Security fixes are
released against the latest published version on the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp)
and the latest GitHub Release. Please reproduce any report against the most
recent release before filing.

| Version | Supported |
| ------- | --------- |
| Latest release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Please do not open public issues, pull requests, or discussions for security
vulnerabilities.** Public disclosure before a fix is available puts users at
risk.

Instead, report privately through GitHub's coordinated disclosure flow:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (GitHub Private Vulnerability Reporting), or use this direct link:
   <https://github.com/Nimblesite/SharpLsp/security/advisories/new>.
2. Include: affected component (Rust host, C#/F# sidecar, or VS Code
   extension), version, a clear description, reproduction steps, and the
   impact you observed.

If you are unable to use the GitHub flow, you may instead email the maintainer
at **cftools@nimblesite.co** with the same details.

## What to expect

- **Acknowledgement:** within 3 business days.
- **Triage & initial assessment:** within 7 business days.
- **Fix & disclosure:** we aim to ship a fix and publish an advisory as soon as
  practical, and will keep you updated on progress. With your agreement we will
  credit you in the advisory.

## Scope notes

SharpLsp executes language-tooling on the code you open, similar to any IDE
language server. Reports we are especially interested in:

- Code execution triggered merely by **opening** a workspace (e.g. a workspace
  trust bypass that runs an attacker-controlled binary).
- Path traversal or arbitrary file read/write outside the workspace.
- Memory-safety or denial-of-service issues reachable from untrusted document
  or project content.
- Secret/credential exposure in builds, logs, or the published extension.
