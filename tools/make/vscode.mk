# Curated target surface for VS Code Makefile Tools.
REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../..)

VSCODE_TARGETS := \
	build \
	ci \
	test \
	test-rust \
	lint \
	fmt \
	clean \
	setup \
	screenshots \
	website-build \
	website-test \
	website-dev

.DEFAULT_GOAL := build
.PHONY: $(VSCODE_TARGETS)

$(VSCODE_TARGETS):
	@$(MAKE) --no-print-directory -C "$(REPO_ROOT)" -f Makefile $@
