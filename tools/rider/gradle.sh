#!/usr/bin/env sh
# Run a Gradle task in the Rider plugin project on a JDK the IntelliJ Platform
# will accept. [DIST-CI-RIDER]
#
# Rider 2026.1 requires JDK 21+, and a developer machine routinely has an older
# JDK first on PATH — the repo's own dev container ships 11. Every Rider make
# target funnels through here so the discovery rules exist exactly once.
#
# Exit codes:
#   0   the task ran and succeeded, OR no JDK was found and RIDER_REQUIRED is unset
#   1   the task failed, or no suitable JDK was found while RIDER_REQUIRED=1
#
# CI sets RIDER_REQUIRED=1 so a missing toolchain fails loudly instead of
# silently skipping the only verification the Rider plugin has.
set -eu

MIN_MAJOR=21
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
RIDER_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/../../src/editors/rider" && pwd)"

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
find_jdk() {
    for candidate in \
        "${JAVA_HOME:-}" \
        /c/Program\ Files/Microsoft/jdk-* \
        /c/Program\ Files/Eclipse\ Adoptium/jdk-* \
        /c/Program\ Files/Java/jdk-* \
        /c/Program\ Files/Android/Android\ Studio/jbr \
        /c/Program\ Files\ \(x86\)/Android/openjdk/jdk-* \
        /c/Program\ Files\ \(x86\)/JetBrains/JetBrains\ Rider*/jbr \
        /usr/lib/jvm/*; do
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
    echo "usage: $0 <gradle-task> [args...]" >&2
    exit 2
}

jdk="$(find_jdk)"
if [ -z "$jdk" ]; then
    if [ -n "${RIDER_REQUIRED:-}" ]; then
        echo "ERROR: Rider needs JDK ${MIN_MAJOR}+. Install one or set JAVA_HOME to it." >&2
        exit 1
    fi
    echo "==> Skipping Rider '$1' (no JDK ${MIN_MAJOR}+ found; set RIDER_REQUIRED=1 to fail instead)"
    exit 0
fi

echo "==> Rider: gradle $* (JDK $jdk)"
cd "$RIDER_DIR"
JAVA_HOME="$jdk" PATH="$jdk/bin:$PATH" ./gradlew "$@" --no-daemon
