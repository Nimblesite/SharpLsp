# RELEASE-PUBLISHING-OIDC-PLAN

Operational runbook for cutting a SharpLsp release that publishes the VS Code
extension to the **VS Code Marketplace** — passwordless, via Microsoft Entra ID
OIDC (workload identity federation) — and to the **Open VSX Registry** (access
token). Implements the publish jobs in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) and the
secrets contract in [`DISTRIBUTION-SPEC.md` → `[DIST-SECRETS]`](../specs/DISTRIBUTION-SPEC.md).

Every load-bearing claim below is cited inline as `[n]`; full URLs are in
[Sources](#sources).

---

## Why Entra ID OIDC (and is it actually more secure?)

**Yes — materially.** A Personal Access Token (PAT) is a long-lived bearer
secret: anyone who obtains it can publish as you until you notice and revoke it.
OIDC stores **no secret at all**. On each run, GitHub mints a short-lived signed
token; Microsoft exchanges it for an access token that lives minutes, only when
the request's `subject`/`issuer`/`audience` exactly match the federated
credential you configured. Nothing durable exists to leak or rotate. Microsoft's
own framing: workload identity federation lets a workload "access Microsoft Entra
protected resources **without using secrets or certificates**" `[5]`, and VS
Code "strongly recommend[s] that extension publishing use Microsoft Entra
ID–based authentication with workload identity federation … **eliminating
long-lived secrets such as Personal Access Tokens (PATs)**" `[1]`. GitHub makes
the same security argument for OIDC over stored cloud credentials `[9]`.

This is not theoretical. Open VSX's June 2025 supply-chain incident was caused by
**leaked long-lived publish tokens** being used to push malware; the remediation
was mass token rotation `[11]`. OIDC removes that entire class of failure for the
Marketplace. (Open VSX itself still has no OIDC path — see [Part D](#part-d--open-vsx-access-token-one-time--rotate).)

### How the Marketplace OIDC chain actually works

The VS Code Marketplace runs on **Azure DevOps**, so publishing authenticates
against Microsoft's identity platform. The flow is:

1. The job requests a GitHub OIDC token (`permissions: id-token: write`).
2. `azure/login@v2` exchanges it with Entra ID for an `az` CLI session — no
   secret, no certificate `[7]`.
3. `vsce` requests an access token for the Azure DevOps resource
   `499b84ac-1321-427f-aa17-267ca6975798/.default` (Azure DevOps' fixed
   first-party app id) and uses it in place of a PAT. `vsce` sets this scope
   itself via an internal `ChainedTokenCredential` that picks up the `az`
   session — you don't pass the scope `[2]`.

> **Note — why this workflow uses an explicit token, not `--azure-credential`:**
> `vsce publish --azure-credential` is the documented flag `[1]`, but it has an
> unresolved class of failures where the token is acquired successfully yet the
> publish is rejected (`microsoft/vscode-vsce#1023` `[3]`; related `#976` `[4]`).
> `release.yml` therefore mints the same Azure DevOps-scoped Entra token
> explicitly (`az account get-access-token --resource 499b84ac-…`) and hands it
> to `vsce` via `VSCE_PAT` (masked, off-argv). It is equally PAT-less — the token
> is a short-lived Entra access token, never a stored PAT — and sidesteps the
> bug `[3]`.

No Azure servers, VMs, subscription, or cost are involved — an "app
registration" is just a free identity (a robot account) in your Entra tenant.

---

## Part A — Azure: Entra ID app + federated credential (one-time)

Requires the `az` CLI logged into the tenant that owns the `Nimblesite`
Marketplace publisher. Portal equivalents are noted; CLI is faster.

```bash
# 1. Create the app registration + service principal
az ad app create --display-name "sharplsp-marketplace-publisher"
APP_ID=$(az ad app list --display-name "sharplsp-marketplace-publisher" --query "[0].appId" -o tsv)
az ad sp create --id "$APP_ID"

# 2. The two ids the workflow needs (NEITHER is a secret value):
#    AZURE_CLIENT_ID = Application (client) ID; AZURE_TENANT_ID = Directory (tenant) ID  [5]
echo "AZURE_CLIENT_ID = $APP_ID"
echo "AZURE_TENANT_ID = $(az account show --query tenantId -o tsv)"

# 3. Add the GitHub-Actions federated credential.
#    Subject MUST be the *environment* form. Entra forbids tag wildcards, and the
#    publish job runs in the `release` environment, so the subject is constant
#    across every v* tag. Issuer + audience values are fixed by Microsoft.  [5]
cat > /tmp/sharplsp-fic.json <<'EOF'
{
  "name": "github-release-environment",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:Nimblesite/SharpLsp:environment:release",
  "description": "GitHub Actions OIDC -> vsce publish (release environment)",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
az ad app federated-credential create --id "$APP_ID" --parameters /tmp/sharplsp-fic.json
```

> Portal `[5]`: **Entra ID → App registrations → New registration**; then on the
> app: **Certificates & secrets → Federated credentials → Add credential →
> "GitHub Actions deploying Azure resources"**, Entity type = **Environment**,
> Environment name = `release`, Organization = `Nimblesite`, Repository =
> `SharpLsp`. Issuer/Audience/Subject auto-populate.

**Two facts that bite people, both confirmed in the Microsoft docs `[5]`:**

- **Tag wildcards are rejected.** Verbatim: *"Wildcard characters aren't
  supported in any federated identity credential property value"* and *"Pattern
  matching isn't supported for branches and tags. Specify an environment if your
  on-push workflow runs against many branches or tags."* `[5]` → that's exactly
  why we bind to the `release` environment instead of `refs/tags/*`.
- **A wrong subject fails silently.** Verbatim: *"If you accidentally add the
  incorrect external workload information in the subject setting the federated
  identity credential is created successfully without error. The error does not
  become apparent until the token exchange fails."* `[5]` So the subject must be
  exactly `repo:Nimblesite/SharpLsp:environment:release`.

## Part B — Marketplace: add the app as a publisher member (one-time)

1. Go to <https://marketplace.visualstudio.com/manage> and sign in as an
   **Owner** of the `Nimblesite` publisher.
2. Open the publisher → **Members → Add**.
3. Add the service principal `sharplsp-marketplace-publisher` (by name /
   `$APP_ID`).
4. Assign role **Contributor** — the role VS Code documents for a publishing
   identity (Owner is only needed to manage members) `[1]`.

> Skipping this is the single most common failure: the OIDC token mints fine but
> the Marketplace rejects the publish with `InvalidAccessException` — exactly the
> symptom in `vscode-vsce#976` before the reporter added the identity as a member
> `[4]`.

## Part C — GitHub: `release` environment + secrets (one-time)

The `release` environment is what injects the `environment:release` claim into
the GitHub OIDC token's subject `[5]`, so it is **required**, not cosmetic.

1. Repo → **Settings → Environments → New environment** → name it exactly
   `release`. Leave **required reviewers OFF** unless you want a manual approval
   gate before each publish (the job will pause until approved if it's on).
2. In the `release` environment → **Add environment secret** ×2 `[7]`:
   - `AZURE_CLIENT_ID` = `$APP_ID` (Application/client ID)
   - `AZURE_TENANT_ID` = tenant id
3. There is **no** `VSCODE_MARKETPLACE_PAT` / `VSCE_PAT` — OIDC replaces it.

```bash
# CLI equivalent (gh >= 2.x):
gh api -X PUT repos/Nimblesite/SharpLsp/environments/release
gh secret set AZURE_CLIENT_ID --env release --body "$APP_ID"
gh secret set AZURE_TENANT_ID --env release --body "$(az account show --query tenantId -o tsv)"
```

## Part D — Open VSX: access token (one-time, + rotate)

Open VSX has **no OIDC / trusted-publishing path** (verified 2026) — a long-lived
token is required `[10]`. Post-2025-incident tokens **expire by default**, so
schedule rotation `[11]`.

1. Sign in to <https://open-vsx.org> with the Eclipse Foundation / GitHub account
   that is a member of the `Nimblesite` namespace (the one that already publishes
   basilisk/diffr/napper). Ensure the **Eclipse Open VSX Publisher Agreement** is
   signed (it prompts in your profile if not) `[10]`.
2. **Settings → Access Tokens → Generate New Token** → copy it (shown once)
   `[10]`.
3. Add it as a **repo** secret:

```bash
gh secret set OPEN_VSX_PAT --body "<token>"
```

> Namespace `Nimblesite` already exists, is **verified**, and is `restricted`
> (members-only publish) — no namespace claim needed for `sharplsp`, since the
> account is already a member `[10]` (namespace policy: `[12]`).

---

## Part E — Cut the release

Pre-flight (all must be true):
- [ ] The OIDC pipeline is on `main` (merged via PR #50 → commit `b833a1a`). ✅
- [ ] Parts A–D complete (Azure app + FIC, Marketplace member, GH env+secrets, `OPEN_VSX_PAT`).
- [ ] Tag is **higher than every burned tag** — `v0.1.0`–`v0.6.0` already exist;
      use `v0.7.0` (or higher). Reusing a burned tag will not move published code.

```bash
git checkout main && git pull
git tag v0.7.0           # plain tag = stable; v0.7.0-rc.1 = pre-release everywhere
git push origin v0.7.0
```

The tag push runs `release.yml`. Watch it:

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

## Verification (after the run is green)

```bash
# Marketplace (expect HTTP 200 once indexed, ~1-2 min)
curl -s -o /dev/null -w "%{http_code}\n" "https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp"
# Open VSX
curl -s "https://open-vsx.org/api/nimblesite/sharplsp" | head
# GitHub release assets
gh release view v0.7.0
```

## Failure playbook

- **`azure/login` fails** → `id-token: write` missing `[7]`, or the FIC subject ≠
  `repo:Nimblesite/SharpLsp:environment:release`, or the `release` environment /
  its secrets don't exist. Remember: a wrong subject fails *silently* at exchange
  time `[5]`.
- **Token minted but Marketplace publish fails (`InvalidAccessException` /
  "corporate credentials")** → the app isn't a publisher **member** (Part B), or
  not **Contributor** `[1]`. This is the `--azure-credential` failure class
  `[3]`; the workflow already uses the explicit-token form to avoid it.
- **Open VSX publish fails auth** → `OPEN_VSX_PAT` missing/expired → regenerate
  (Part D); post-2025 tokens expire by default `[11]`. Account must be a member
  of the `Nimblesite` namespace `[12]`.
- **Re-running the SAME tag** republishes the same version → the Marketplace
  rejects duplicates. Push a new patch tag (`v0.7.1`) after any fix instead.

---

## Sources

**VS Code Marketplace / vsce**
1. VS Code — *Publishing Extensions* (official): Entra ID + workload identity
   federation publishing, `--azure-credential` (vsce ≥ 2.26.1), **Contributor**
   publisher role, Azure DevOps resource id `499b84ac-1321-427f-aa17-267ca6975798`.
   <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
2. `microsoft/vscode-vsce` — `src/auth.ts` (source): internal
   `ChainedTokenCredential`, scope `499b84ac-…/.default`,
   `AZURE_CLIENT_ID`/`AZURE_TENANT_ID` env handling.
   <https://github.com/microsoft/vscode-vsce/blob/main/src/auth.ts>
3. `microsoft/vscode-vsce` issue #1023 — `--azure-credential`: `verify-pat`
   succeeds, `publish` fails ("corporate credentials"); closed not-planned.
   <https://github.com/microsoft/vscode-vsce/issues/1023>
4. `microsoft/vscode-vsce` issue #976 — `InvalidAccessException` /
   identity-selection bug (fixed in vsce 2.30.0); publisher-membership requirement.
   <https://github.com/microsoft/vscode-vsce/issues/976>

**Microsoft Entra ID / Azure OIDC**
5. Microsoft Learn — *Create a trust relationship between an app and an external
   identity provider* (updated 2026-02-26): subject formats
   (`…:environment:<name>`, `…:ref:refs/tags/<tag>`, `…:pull-request`),
   **"Wildcard characters aren't supported"**, **"Pattern matching isn't
   supported for branches and tags. Specify an environment…"**, silent-failure
   warning, issuer `https://token.actions.githubusercontent.com`, audience
   `api://AzureADTokenExchange`, `AZURE_CLIENT_ID`/`AZURE_TENANT_ID` mapping.
   <https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust>
6. Microsoft Learn — *Workload identity federation* (overview): "access Microsoft
   Entra protected resources without needing to manage secrets."
   <https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation>
7. `Azure/login` GitHub Action: `client-id`/`tenant-id`/`allow-no-subscriptions`,
   requires `permissions: id-token: write`.
   <https://github.com/Azure/login>
8. Microsoft Learn — *Authenticate to Azure from GitHub Actions by OpenID Connect*.
   <https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect>

**GitHub OIDC security rationale**
9. GitHub Docs — *About security hardening with OpenID Connect*: why OIDC
   replaces long-lived cloud secrets in Actions.
   <https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect>

**Open VSX**
10. Eclipse Foundation — *Open VSX: Publishing Extensions* wiki: Eclipse account +
    Publisher Agreement, access tokens, `ovsx` publish.
    <https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions>
11. Open VSX June 2025 token-leak incident + Oct 2025 token revocation/rotation
    (why long-lived PATs are the risk OIDC removes; why Open VSX tokens now
    expire). <https://thehackernews.com/2025/06/critical-open-vsx-registry-flaw-exposes.html>
    · <https://thehackernews.com/2025/10/eclipse-foundation-revokes-leaked-open.html>
12. `eclipse/openvsx` — *Namespace Access* wiki: members-only publishing,
    verified namespaces, claiming a namespace.
    <https://github.com/eclipse/openvsx/wiki/Namespace-Access>

## TODO

- [ ] Part A — Entra app + service principal + federated credential
- [ ] Part B — Marketplace publisher member (Contributor)
- [ ] Part C — GitHub `release` environment + `AZURE_CLIENT_ID` / `AZURE_TENANT_ID`
- [ ] Part D — `OPEN_VSX_PAT` repo secret
- [x] OIDC pipeline merged to `main` (PR #50)
- [ ] Part E — push `v0.7.0`, watch run green
- [ ] Verify Marketplace + Open VSX + GitHub Release
- [ ] (Follow-up) move source versions to `0.0.0-dev`; rotate `OPEN_VSX_PAT` on schedule
