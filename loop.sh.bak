#!/usr/bin/env bash
# Resilient overnight loop for fww-b2b-admin.
# Each iteration spawns a fresh `claude -p` reading HANDOFF.md. Exits when STATUS.md is
# terminal (STATE: DONE | FAILED | BLOCKED) or after MAX_ITERS iterations.
set -a; . "$HOME/.secrets/anthropic.env"; set +a
set -a; . "$HOME/.secrets/github.env" 2>/dev/null || true; set +a
cd "$HOME/projects/fww-b2b-admin" || exit 1
mkdir -p runs runs/screenshots

MAX_ITERS=${MAX_ITERS:-20}
MAX_TURNS=${MAX_TURNS:-280}

echo "=================================================================" >> runs/loop.log
echo "loop start $(date -u +%FT%TZ)  (max_iters=$MAX_ITERS, max_turns=$MAX_TURNS)" >> runs/loop.log
echo "=================================================================" >> runs/loop.log

CONT="You are headless Claude on fww-vps-1, working on fww-b2b-admin. Read HANDOFF.md in full,
then STATUS.md + SCRATCH.md + RESEARCH.md (if exists) + the last 20 git log entries. Then do
the next concrete step, commit + push, update STATUS.md, and exit. Each iteration ships
something. Do not start over — continue from current state."

for i in $(seq 1 $MAX_ITERS); do
  if grep -qE "^STATE: (DONE|FAILED|BLOCKED)" STATUS.md 2>/dev/null; then
    STATE=$(grep -E "^STATE:" STATUS.md | head -1)
    echo "loop: terminal $STATE at iter $i, stopping $(date -u +%FT%TZ)" >> runs/loop.log
    break
  fi

  echo "" >> runs/loop.log
  echo "=== ITER $i START $(date -u +%FT%TZ) ===" >> runs/loop.log
  git pull -q --rebase=false 2>/dev/null || true

  claude -p "$(cat HANDOFF.md)

$CONT" \
    --permission-mode bypassPermissions \
    --max-turns $MAX_TURNS \
    --output-format stream-json \
    --verbose \
    >> runs/loop.log 2>&1

  EXIT=$?
  echo "=== ITER $i EXIT $EXIT $(date -u +%FT%TZ) ===" >> runs/loop.log

  git push -q 2>>runs/loop.log || true

  sleep 6
done

echo "" >> runs/loop.log
echo "loop finished $(date -u +%FT%TZ)" >> runs/loop.log
echo "final STATUS.md:" >> runs/loop.log
head -10 STATUS.md >> runs/loop.log
