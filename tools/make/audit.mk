# [DIST-CI-AUDIT] Dependency vulnerability audit.
#
#   make audit                    audit every dependency the repo ships or builds with
#   make audit AUDIT_LEVEL=low    fail on every advisory, not just moderate and above
#
# Each ecosystem is checked against its own advisory database:
#
#   Rust  cargo audit (RustSec)                    root workspace + Zed extension
#   .NET  dotnet list package --vulnerable         sidecar solution, transitive included
#   npm   npm audit                                VS Code extension + website
#
# Every finding names the vulnerable package, its version and the advisory;
# cargo audit and npm audit also print the version to upgrade to. All three
# scanners run even when an earlier one fails, so ONE run lists everything that
# needs upgrading. This exact target is the CI job (ci-audit.yml) that gates
# every PR and every release.
#
# npm audit reads package-lock.json only (--package-lock-only), so it never
# touches node_modules.

AUDIT_LEVEL       ?= moderate
AUDIT_CARGO_LOCKS  = Cargo.lock $(ZED_DIR)/Cargo.lock
AUDIT_NPM_DIRS     = $(VSCODE_DIR) src/website
AUDIT_DOTNET_JSON  = target/audit-dotnet.json

.PHONY: audit _audit-rust _audit-dotnet _audit-npm

audit:
	@status=0; \
	$(MAKE) --no-print-directory _audit-rust || status=1; \
	$(MAKE) --no-print-directory _audit-dotnet || status=1; \
	$(MAKE) --no-print-directory _audit-npm || status=1; \
	if [ $$status -ne 0 ]; then \
		echo "ERROR: vulnerable dependencies found - upgrade the packages reported above." >&2; \
		exit 1; \
	fi; \
	echo "==> No vulnerable dependencies at or above '$(AUDIT_LEVEL)'."

# cargo audit fails on any vulnerability. Yanked, unsound and unmaintained crates
# are printed as warnings but do not fail.
_audit-rust:
	@command -v cargo-audit >/dev/null || { \
		echo "ERROR: cargo-audit is not installed. Run: cargo install cargo-audit --locked" >&2; \
		exit 1; \
	}
	@status=0; for lock in $(AUDIT_CARGO_LOCKS); do \
		echo "==> cargo audit $$lock"; \
		cargo audit --file "$$lock" || status=1; \
	done; exit $$status

_audit-dotnet:
	@echo "==> dotnet list package --vulnerable $(SIDECAR_SLN)"
	@mkdir -p $(dir $(AUDIT_DOTNET_JSON))
	dotnet restore $(SIDECAR_SLN) --verbosity quiet
	dotnet list $(SIDECAR_SLN) package --vulnerable --include-transitive --format json > $(AUDIT_DOTNET_JSON)
	@node tools/audit/dotnet-vulnerable.mjs $(AUDIT_DOTNET_JSON) $(AUDIT_LEVEL)

_audit-npm:
	@status=0; for dir in $(AUDIT_NPM_DIRS); do \
		echo "==> npm audit $$dir (fails at $(AUDIT_LEVEL) and above)"; \
		(cd "$$dir" && npm audit --package-lock-only --audit-level=$(AUDIT_LEVEL)) || status=1; \
	done; exit $$status
