#!/usr/bin/env bash
# check-coverage.sh — enforce and ratchet a coverage threshold
#
# Usage: check-coverage.sh <project-key> <actual-percent>
#
# Reads the threshold from coverage-thresholds.json for the given project key.
# - If actual < threshold → exit 1 (hard fail)
# - If actual > threshold → update the threshold (ratchet up) and exit 0
# - If actual == threshold → exit 0 (no change)
set -euo pipefail

PROJECT="$1"
ACTUAL="$2"
THRESHOLDS="coverage-thresholds.json"

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

echo "[$PROJECT] coverage: ${ACTUAL}% (threshold: ${THRESHOLD}%)"

BELOW=$(echo "$ACTUAL < $THRESHOLD" | bc -l)
if [ "$BELOW" -eq 1 ]; then
  echo "FAIL: [$PROJECT] coverage ${ACTUAL}% dropped below threshold ${THRESHOLD}%" >&2
  exit 1
fi

ABOVE=$(echo "$ACTUAL > $THRESHOLD" | bc -l)
if [ "$ABOVE" -eq 1 ]; then
  ROUNDED=$(echo "$ACTUAL" | jq -n 'input | . * 100 | floor | . / 100')
  echo "[$PROJECT] coverage improved! Ratcheting threshold: ${THRESHOLD}% → ${ROUNDED}%"
  jq --arg p "$PROJECT" --argjson new "$ROUNDED" '.[$p].line_percent = $new' "$THRESHOLDS" > tmp-thresholds.json
  mv tmp-thresholds.json "$THRESHOLDS"
fi
