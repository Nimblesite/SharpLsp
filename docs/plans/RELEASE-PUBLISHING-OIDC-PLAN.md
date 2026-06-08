# RELEASE-PUBLISHING-OIDC-PLAN

Operational runbook for cutting a SharpLsp release that publishes the VS Code
extension to the **VS Code Marketplace** (passwordless, Microsoft Entra ID OIDC)
and the **Open VSX Registry** (access token). Implements the publish jobs in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) and the
secrets contract in [`DISTRIBUTION-SPEC.md` → `[DIST-SECRETS]`](../specs/DISTRIBUTION-SPEC.md).

## How publishing works

A `v*` tag push triggers `release.yml`:

1. `version` → extracts version from the tag, validates manifests.
2. `build-vsix` (matrix) → stamps the tag version, builds per-platform VSIXes.
3. `release` → GitHub Release + `SHA256SUMS`.
4. `publish-marketplace` → **Entra ID OIDC**, no PAT. Runs in the `release`
   environment so its OIDC subject is `repo:Nimblesite/SharpLsp:environment:release`.
5. `publish-openvsx` → **`OPEN_VSX_PAT`** access token (Open VSX has no OIDC path).

Marketplace publisher `Nimblesite` and Open VSX namespace `Nimblesite` already
exist and are verified, so neither needs to be created/claimed. The Marketplace
item `nimblesite.sharplsp` is a first publish.

---

## Part A — Azure: Entra ID app + federated credential (one-time)

Requires the `az` CLI logged into the tenant that owns the Marketplace publisher.
Portal equivalents are noted; CLI is faster.

```bash
# 1. Create the app registration + service principal
az ad app create --display-name "sharplsp-marketplace-publisher"
APP_ID=$(az ad app list --display-name "sharplsp-marketplace-publisher" --query "[0].appId" -o tsv)
OBJ_ID=$(az ad app list --display-name "sharplsp-marketplace-publisher" --query "[0].id" -o tsv)
az ad sp create --id "$APP_ID"

# 2. Capture the two ids the workflow needs (NEITHER is a secret value)
echo "AZURE_CLIENT_ID = $APP_ID"
echo "AZURE_TENANT_ID = $(az account show --query tenantId -o tsv)"

# 3. Add the GitHub-Actions federated credential.
#    Subject MUST be the environment form — Entra rejects tag wildcards, and the
#    job runs in the `release` environment, so the subject is constant across tags.
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

> Portal: **Entra ID → App registrations → New registration**; then
> **Certificates & secrets → Federated credentials → Add credential →
> "GitHub Actions deploying Azure resources"**, Entity = **Environment**,
> Environment name = `release`, Org = `Nimblesite`, Repo = `SharpLsp`.

⚠️ The subject must match GitHub's OIDC `sub` **character-for-character**. A wrong
subject still creates successfully but fails silently at token-exchange time.

## Part B — Marketplace: add the app as a publisher member (one-time)

1. Go to <https://marketplace.visualstudio.com/manage> and sign in as an **Owner**
   of the `Nimblesite` publisher.
2. Open the publisher → **Members → Add**.
3. Add the service principal `sharplsp-marketplace-publisher` (by name / `$APP_ID`).
4. Assign role **Contributor** (sufficient to publish; Owner only manages members).

> Skipping this is the #1 failure cause — the OIDC token is minted fine but the
> Marketplace rejects the publish with `InvalidAccessException`.

## Part C — GitHub: `release` environment + secrets (one-time)

1. Repo → **Settings → Environments → New environment** → name it exactly
   `release`. Leave **required reviewers OFF** unless you want a manual approval
   gate before each publish (the job will pause until approved if it's on).
2. In the `release` environment → **Add environment secret** ×2:
   - `AZURE_CLIENT_ID` = `$APP_ID` from Part A
   - `AZURE_TENANT_ID` = tenant id from Part A
3. (No `VSCODE_MARKETPLACE_PAT` / `VSCE_PAT` — OIDC replaces it entirely.)

```bash
# CLI equivalent (gh >= 2.x):
gh api -X PUT repos/Nimblesite/SharpLsp/environments/release
gh secret set AZURE_CLIENT_ID --env release --body "$APP_ID"
gh secret set AZURE_TENANT_ID --env release --body "$(az account show --query tenantId -o tsv)"
```

## Part D — Open VSX: access token (one-time, + rotate)

Open VSX still has **no OIDC** — a long-lived token is required.

1. Sign in to <https://open-vsx.org> with the Eclipse Foundation / GitHub account
   that is a member of the `Nimblesite` namespace (the one that publishes
   basilisk/diffr/napper). Ensure the **Eclipse Open VSX Publisher Agreement** is
   signed (Profile → it prompts if not).
2. **Settings → Access Tokens → Generate New Token** → copy it (shown once).
3. Add it as a **repo** secret:

```bash
gh secret set OPEN_VSX_PAT --body "<token>"
```

> Post-2025 Open VSX tokens **expire by default** — set a calendar reminder to
> rotate, and regenerate if a publish fails with an auth error.

---

## Part E — Cut the release

Pre-flight (all must be true):
- [ ] PR #49 (the fixed pipeline) is **merged to `main`**.
- [ ] Parts A–D complete (Azure app + FIC, Marketplace member, GH env+secrets, OVSX_PAT).
- [ ] Tag is **higher than every burned tag** — `v0.1.0`–`v0.6.0` already exist;
      use `v0.7.0` (or higher). Reusing a burned tag will not move the published code.

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

- **`azure/login` fails** → `id-token: write` missing, or the FIC subject ≠
  `repo:Nimblesite/SharpLsp:environment:release`, or the `release` environment /
  its secrets don't exist.
- **Token minted but Marketplace publish fails (`InvalidAccessException` /
  "corporate credentials")** → the app isn't a publisher **member** (Part B), or
  not **Contributor**. This is the `--azure-credential` bug class
  (microsoft/vscode-vsce#1023); the workflow already uses the explicit-token form
  to avoid it.
- **Open VSX publish fails auth** → `OPEN_VSX_PAT` missing/expired → regenerate
  (Part D). Account must be a member of the `Nimblesite` namespace.
- **Re-running the SAME tag** republishes the same version → the Marketplace
  rejects duplicates. Push a new patch tag (`v0.7.1`) after any fix instead.

## TODO

- [ ] Part A — Entra app + service principal + federated credential
- [ ] Part B — Marketplace publisher member (Contributor)
- [ ] Part C — GitHub `release` environment + `AZURE_CLIENT_ID` / `AZURE_TENANT_ID`
- [ ] Part D — `OPEN_VSX_PAT` repo secret
- [ ] Merge PR #49 to `main`
- [ ] Part E — push `v0.7.0`, watch run green
- [ ] Verify Marketplace + Open VSX + GitHub Release
- [ ] (Follow-up) move source versions to `0.0.0-dev`; rotate OVSX_PAT on schedule
