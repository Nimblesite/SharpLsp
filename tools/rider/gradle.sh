#!/usr/bin/env sh
# Run a Gradle task in the Rider plugin project on a JDK the IntelliJ Platform
# will accept. [DIST-CI-RIDER]
#
# Rider 2026.1 requires JDK 21+, and a developer machine routinely has an older
# JDK first on PATH — the repo's own dev container ships 11. Every Rider make
# target funnels through here so the discovery rules exist exactly once.
#
# Usage:
#   gradle.sh <gradle-task> [args...]   run the task on the first JDK 21+
#   gradle.sh --jdk                     print that JDK; nothing when there is none
#
# Exit codes:
#   0   the task ran and succeeded, OR no JDK was found and RIDER_REQUIRED is unset
#   1   the task failed, or no suitable JDK was found while RIDER_REQUIRED=1
#   2   usage error
#
# A local skip is not silent: it leaves a marker in $SKIPPED_LEGS_DIR (default
# target/skipped-legs) that `make test` and `make ci` list last, so a green run
# never quietly means "did not run" (GitHub #274). Running the task clears its
# marker. CI sets RIDER_REQUIRED=1 so a missing toolchain fails loudly instead.
#
# RIDER_JDK_SYSROOT prefixes every built-in search location, so a test can hand
# the script a fixture machine; it is unset on a real one.
set -eu

MIN_MAJOR=21
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
RIDER_DIR="$REPO_ROOT/src/editors/rider"
SKIPPED_DIR="${SKIPPED_LEGS_DIR:-$REPO_ROOT/target/skipped-legs}"
ROOT="${RIDER_JDK_SYSROOT:-}"

# Major version of the JDK at $1, or nothing if it is not a runnable JDK.
java_major() {
    _exe="$1/bin/java"
    [ -x "$_exe" ] || _exe="$1/bin/java.exe"
    [ -x "$_exe" ] || return 0

    "$_exe" -XshowSettings:properties -version 2>&1 |
        sed -n 's/^[[:space:]]*java.specification.version = //p' |
        head -n1 |
        cut -d. -f1
}

# First JDK on the machine at or above $MIN_MAJOR, preferring $JAVA_HOME.
#
# macOS JDKs live under /Library and, far more often, under Homebrew's opt/
# prefixes (Apple silicon, then Intel), where the JDK home inside the keg is
# libexec/openjdk.jdk/Contents/Home. /usr/libexec/java_home is deliberately NOT
# consulted: it cannot see Homebrew JDKs, and asked for 21 it answers with a 17
# and exits 0 — the very failure this script exists to prevent (GitHub #274).
find_jdk() {
    for candidate in \
        "${JAVA_HOME:-}" \
        "$ROOT"/c/Program\ Files/Microsoft/jdk-* \
        "$ROOT"/c/Program\ Files/Eclipse\ Adoptium/jdk-* \
        "$ROOT"/c/Program\ Files/Java/jdk-* \
        "$ROOT"/c/Program\ Files/Android/Android\ Studio/jbr \
        "$ROOT"/c/Program\ Files\ \(x86\)/Android/openjdk/jdk-* \
        "$ROOT"/c/Program\ Files\ \(x86\)/JetBrains/JetBrains\ Rider*/jbr \
        "$ROOT"/usr/lib/jvm/* \
        "$ROOT"/Library/Java/JavaVirtualMachines/*/Contents/Home \
        "$ROOT"/opt/homebrew/opt/openjdk*/libexec/openjdk.jdk/Contents/Home \
        "$ROOT"/usr/local/opt/openjdk*/libexec/openjdk.jdk/Contents/Home; do
        [ -n "$candidate" ] && [ -d "$candidate" ] || continue
        major="$(java_major "$candidate")"
        case "$major" in '' | *[!0-9]*) continue ;; esac
        if [ "$major" -ge "$MIN_MAJOR" ]; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 0
}

[ "$#" -ge 1 ] || {
    echo "usage: $0 <gradle-task> [args...] | --jdk" >&2
    exit 2
}

jdk="$(find_jdk)"
if [ "$1" = "--jdk" ]; then
    [ -z "$jdk" ] || printf '%s\n' "$jdk"
    exit 0
fi

marker="$SKIPPED_DIR/rider-$1"
if [ -z "$jdk" ]; then
    if [ -n "${RIDER_REQUIRED:-}" ]; then
        echo "ERROR: Rider needs JDK ${MIN_MAJOR}+. Install one or set JAVA_HOME to it." >&2
        exit 1
    fi
    mkdir -p "$SKIPPED_DIR"
    echo "Rider '$1': no JDK ${MIN_MAJOR}+ found (set JAVA_HOME, or RIDER_REQUIRED=1 to fail)" >"$marker"
    echo "==> Skipping Rider '$1' (no JDK ${MIN_MAJOR}+ found; set RIDER_REQUIRED=1 to fail instead)"
    exit 0
fi

rm -f "$marker"
echo "==> Rider: gradle $* (JDK $jdk)"
cd "$RIDER_DIR"
JAVA_HOME="$jdk" PATH="$jdk/bin:$PATH" ./gradlew "$@" --no-daemon
