#!/usr/bin/env bash
# check-coverage.sh — enforce and ratchet a coverage threshold
#
# Usage: check-coverage.sh <project-key> <actual-percent>
#
# Reads the threshold from coverage-thresholds.json for the given project key.
# - If actual < (threshold - TOLERANCE) → exit 1 (hard fail)
# - If actual > threshold               → update the threshold (ratchet up) and exit 0
# - Otherwise                            → exit 0 (within tolerance, no change)
#
# A 1pp tolerance is always applied when comparing against the stored
# threshold to absorb llvm-cov rounding / instrumentation noise across
# platforms. When ratcheting UP we also subtract 1pp from the rounded
# actual so the baseline we persist sits comfortably above the noise
# floor on the next run.
set -euo pipefail

PROJECT="$1"
ACTUAL="$2"
THRESHOLDS="coverage-thresholds.json"
# Absolute percentage-point tolerance applied to every project. Must
# match the amount subtracted when ratcheting up (see below).
TOLERANCE=1

if [ ! -f "$THRESHOLDS" ]; then
  echo "ERROR: $THRESHOLDS not found" >&2
  exit 1
fi

THRESHOLD=$(jq -r --arg p "$PROJECT" '.[$p].line_percent // empty' "$THRESHOLDS")
if [ -z "$THRESHOLD" ]; then
  echo "ERROR: no threshold found for project '$PROJECT' in $THRESHOLDS" >&2
  exit 1
fi

# Guard: threshold must NEVER decrease from the baseline.
# On feature branches, use the merge-base with main so intermediate
# ratchets don't block subsequent commits with slightly lower coverage.
BASELINE_REF="HEAD"
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || true)
if [ -n "$MERGE_BASE" ] && [ "$(git rev-parse HEAD)" != "$MERGE_BASE" ]; then
  BASELINE_REF="$MERGE_BASE"
fi
COMMITTED_THRESHOLD=$(git show "$BASELINE_REF":"$THRESHOLDS" 2>/dev/null | jq -r --arg p "$PROJECT" '.[$p].line_percent // empty' 2>/dev/null || true)
if [ -n "$COMMITTED_THRESHOLD" ]; then
  REGRESSED=$(echo "$THRESHOLD < $COMMITTED_THRESHOLD" | bc -l)
  if [ "$REGRESSED" -eq 1 ]; then
    echo "FAIL: [$PROJECT] threshold was lowered from ${COMMITTED_THRESHOLD}% to ${THRESHOLD}% — coverage thresholds must NEVER decrease" >&2
    exit 1
  fi
fi

EFFECTIVE_THRESHOLD=$(echo "$THRESHOLD - $TOLERANCE" | bc -l)
echo "[$PROJECT] coverage: ${ACTUAL}% (threshold: ${THRESHOLD}%, effective: ${EFFECTIVE_THRESHOLD}% with ${TOLERANCE}pp tolerance)"

BELOW=$(echo "$ACTUAL < $EFFECTIVE_THRESHOLD" | bc -l)
if [ "$BELOW" -eq 1 ]; then
  echo "FAIL: [$PROJECT] coverage ${ACTUAL}% dropped below effective threshold ${EFFECTIVE_THRESHOLD}% (stored: ${THRESHOLD}%)" >&2
  exit 1
fi

ABOVE=$(echo "$ACTUAL > $THRESHOLD" | bc -l)
if [ "$ABOVE" -eq 1 ]; then
  # Ratchet to `actual - tolerance` (floored to 2dp) so the new baseline
  # already bakes in the tolerance and cannot be undermined by a noisy
  # follow-up run on a different platform.
  NEW_THRESHOLD=$(echo "$ACTUAL" | jq -n --argjson tol "$TOLERANCE" 'input - $tol | . * 100 | floor | . / 100')
  # Never ratchet DOWN the committed value even if (actual - tolerance)
  # would do so: the committed threshold is the contractual floor.
  RATCHET_OK=$(echo "$NEW_THRESHOLD > $THRESHOLD" | bc -l)
  if [ "$RATCHET_OK" -eq 1 ]; then
    echo "[$PROJECT] coverage improved! Ratcheting threshold: ${THRESHOLD}% → ${NEW_THRESHOLD}% (actual ${ACTUAL}% − ${TOLERANCE}pp)"
    jq --arg p "$PROJECT" --argjson new "$NEW_THRESHOLD" '.[$p].line_percent = $new' "$THRESHOLDS" > tmp-thresholds.json
    mv tmp-thresholds.json "$THRESHOLDS"
  fi
fi
